# 15D Wings — Sub-72 Database Assessment Worker

**Version:** `15D-SUB72-DATABASE-2.0`  
**Decision engine:** deterministic database-only  
**External AI / Google Search:** not used  
**Supabase project:** `mhplukffgcxiorpfunyy`

## What this Worker does

The Worker receives the existing DispatchTelemetryPayload-style frontend request, validates the canonical mission reference, reads the existing 15D aviation reference tables, calculates route distance from airport coordinates, evaluates aircraft catalogue capacity/range, writes an immutable assessment snapshot to `sub_72_hour_mission_assessments`, returns a binary `GO` or `NO_GO`, and dispatches the result to the existing Comms Worker.

The GO/NO-GO decision is returned before any optional sourcing-fee step. This Worker does not collect payment and does not authorise sourcing activation.

## Database tables read

- `airports` — airport identity, type, coordinates, country and region codes.
- `runways` — only canonical links with `airport_match_status` of `MATCHED_SOURCE_ID` or `MATCHED_COORDINATES` are considered.
- `region` — validates airport region references and supports jurisdiction classification.
- `navaids` — attached as supporting reference information; navaid presence is not a mandatory airport-eligibility condition.
- `aircrafts` — aircraft type/model, `Max_Passengers`, `Range_NM` and cruise speed.
- `fleet_aircraft` — included as informational inventory data only; current availability is not independently verified by this Worker.
- `aviation_data_sources` — source-provenance metadata is copied into the assessment evidence.

The database source registry identifies OurAirports Open Data as `SUPPLEMENTARY` for the imported airports/runways/navaids data and explicitly disclaims accuracy or fitness-for-use warranties. The original retrieval timestamp, exact source version and checksums were not retained. The Worker preserves that limitation in the returned evidence.

The Worker does not query `airport_operating_hours`, `airport_services`, `approach_procedures`, `airport_restrictions`, `runway_declared_distances`, or `aviation_permit_rules` as decision inputs because those tables were empty at the time this Worker was prepared. It does not query live NOTAMs, weather, slots, permits, operator systems or external research services.

## Deterministic GO conditions

A mission receives `GO` only when all of these database checks pass:

1. Every origin and destination airport resolves uniquely from the database.
2. Every airport is classified as `small_airport`, `medium_airport` or `large_airport`.
3. Every airport has an ISO country code and a matching `region.code` record.
4. Every airport has at least one runway linked by a canonical match, where `closed = false`, length and width are positive, and surface is populated.
5. The route is domestic for this Sub-72 entry point. The existing 15D Sub-72 doctrine locks international/mixed-jurisdiction routes at 72 hours by default. No approved-corridor table currently exists, so the Worker does not infer an exception.
6. At least one aircraft catalogue model in the requested class/model has `Max_Passengers` greater than or equal to the manifest passenger count and `Range_NM` greater than or equal to the longest database-calculated great-circle leg.
7. All multi-leg route connections are continuous.

If any required condition fails or the database cannot establish it, the result is `NO_GO` with one or more reason codes. Database query failures are service errors (HTTP 502/503), not mission NO-GO results.

### Important technical boundary

The runway check confirms that the database contains a positively linked runway record with dimensions and a surface. It does **not** calculate aircraft-specific take-off/landing performance. Aircraft range is a catalogue reference figure; it does not account for payload, reserves, weather, routing, alternates or operational restrictions. The resulting GO is a **database eligibility result only** — not an aircraft reservation, permit approval, operator acceptance, dispatch release or guarantee of flight execution.

The frontend-supplied `distanceKm` is preserved for contract compatibility but ignored for the decision. The Worker computes great-circle distance from the database airport coordinates. A navaid count is included as descriptive evidence but does not determine GO/NO-GO by itself.

## Frontend request contract

Required root fields:

- `name`
- `email`
- `request_id`
- `ref_id`
- `aircraft`
- `legs`
- `manifest`

`request_id` and `ref_id` must match `^15D-[A-Z0-9]{5}$`.

Each leg requires `from`, `to`, and `departure_timestamptz` (ISO-8601 with explicit timezone). Existing fields such as `cost`, `distanceKm`, `techStops`, `date`, `time`, `fromFull`, `toFull`, and `return_timestamptz` are retained. The Worker does not trust `distanceKm` for its decision.

Passenger count is read from `manifest.passengers_count`, `manifest.passenger_count`, `manifest.totalPax`, `manifest.total_pax`, `manifest.pax`, root `passengers`/`pax`/`passenger_count`, or the sum of `manifest.adults + children + infants`.

## Response

The completed response contains:

- `decision`: `GO` or `NO_GO`
- `outcome`: `SOURCING_GO` or `SOURCING_NO_GO`
- `reason_codes` and `blockers`
- resolved route and jurisdiction classification
- matched aircraft catalogue models
- airport, runway, navaid and region evidence
- explicit limitations
- `permissions.fee_collection_before_assessment: false`
- `permissions.sourcing_activation_authorised: false`

## Existing same-day fee boundary

The assessment is not paywalled. If `SUB72_LANE_B_FEE_AMOUNT` is configured, the response may disclose the same-day sourcing fee for a later step. It is explicitly timed **after GO and before active sourcing**. The Worker itself does not collect the fee or activate sourcing. The existing doctrine specifies a $160 same-day sourcing fee; the amount is configurable rather than hard-coded.

## Supabase persistence

Uses the existing `public.sub_72_hour_mission_assessments` table and existing `public.missions` canonical mission flow. It calls the existing `upsert_mission_direct` RPC with the same argument contract used by the previous Sub-72 Worker. Existing non-Sub-72 mission rows are not overwritten.

Assessment idempotency key: `${mission_id}:SUB72:DATABASE_V2`.

The existing audit table's JSONB columns are reused:

- `airfield_payload`: database-resolved route snapshot.
- `intelligence_payload`: records `DATABASE_ONLY`; no model output.
- `evidence_payload`: airport/runway/navaid/region/catalogue evidence and limitations.
- `decision_payload`: binary decision and reason codes.
- `frontend_response`: complete frontend response.

No migration is required by this package.

## Cloudflare configuration

1. Set the exact browser origin(s) in `ALLOWED_ORIGINS`.
2. Keep `SUPABASE_SERVICE_ROLE_KEY` as a Worker secret only.
3. Bind the existing Comms Worker as service `noreply-wings` with binding name `noreply-wings`, or set `COMMS_DISPATCH_URL`.
4. Configure Cloudflare WAF/rate limiting. CORS is not authentication and does not prevent direct HTTP requests.
5. Do not add Gemini credentials or AIRFIELDS bindings; this version uses neither.

### Secrets

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

### Local checks

```bash
npm test
npm run check
```

### Deploy

```bash
npx wrangler deploy
```

### Tail logs

```bash
npx wrangler tail sub-72-assessment --format pretty
```

## Endpoints

- `GET /health`
- `POST /`
- `POST /assess`
- `POST /v1/sub-72-hour-mission-assessment`

## Deployment warning

This package has unit tests for the deterministic evaluator. It has not been deployed against your production Cloudflare account, and the live Supabase REST credentials / Comms binding have not been exercised by this package. Before live use, verify the `upsert_mission_direct` RPC still has the argument names in `assessment-store.js`, set the real frontend origin, and test with a controlled mission ID that does not collide with an existing mission. Do not use a real client mission as the first smoke test.
