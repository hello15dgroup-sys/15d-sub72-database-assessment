const DEFAULT_SUPABASE_URL = 'https://mhplukffgcxiorpfunyy.supabase.co';
const ASSESSMENT_TABLE = 'sub_72_hour_mission_assessments';
const STABLECOIN_INTENT_TABLE = 'stablecoin_settlement_intents';

function credentials(env) {
  const url = (env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw fail('SUPABASE_CONFIG_MISSING', 503, 'SUPABASE_SERVICE_ROLE_KEY is required.');
  return { url, key };
}

function headers(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

export async function findAssessmentByIdempotency(env, idempotencyKey) {
  const { url, key } = credentials(env);
  const params = new URLSearchParams({
    idempotency_key: `eq.${idempotencyKey}`,
    select: '*',
    limit: '1',
  });
  const response = await fetch(`${url}/rest/v1/${ASSESSMENT_TABLE}?${params}`, {
    headers: headers(key),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await dbError(response, 'ASSESSMENT_LOOKUP_FAILED');
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function findAssessmentByRunId(env, assessmentRunId) {
  const { url, key } = credentials(env);
  const params = new URLSearchParams({
    assessment_run_id: `eq.${assessmentRunId}`,
    select: '*',
    limit: '1',
  });
  const response = await fetch(`${url}/rest/v1/${ASSESSMENT_TABLE}?${params}`, {
    headers: headers(key),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await dbError(response, 'ASSESSMENT_LOOKUP_FAILED');
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function createAssessment(env, record) {
  const { url, key } = credentials(env);
  const response = await fetch(`${url}/rest/v1/${ASSESSMENT_TABLE}`, {
    method: 'POST',
    headers: headers(key, { Prefer: 'return=representation' }),
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw await dbError(response, 'ASSESSMENT_CREATE_FAILED');
}

export async function updateAssessment(env, assessmentRunId, patch) {
  const { url, key } = credentials(env);
  const params = new URLSearchParams({ assessment_run_id: `eq.${assessmentRunId}` });
  const response = await fetch(`${url}/rest/v1/${ASSESSMENT_TABLE}?${params}`, {
    method: 'PATCH',
    headers: headers(key, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw await dbError(response, 'ASSESSMENT_UPDATE_FAILED');
}

export async function persistCanonicalMission(env, mission, committedAt) {
  const { url, key } = credentials(env);
  const params = new URLSearchParams({
    id: `eq.${mission.missionId}`,
    select: 'id,client_email,raw_payload',
    limit: '1',
  });
  const existingResponse = await fetch(`${url}/rest/v1/missions?${params}`, {
    headers: headers(key),
    signal: AbortSignal.timeout(15_000),
  });
  if (!existingResponse.ok) throw await dbError(existingResponse, 'MISSION_LOOKUP_FAILED');
  const existingRows = await existingResponse.json();

  if (Array.isArray(existingRows) && existingRows.length) {
    const existing = existingRows[0];
    const entrypoint = existing.raw_payload?.sub72_assessment?.entrypoint;
    const sameClient = String(existing.client_email || '').toLowerCase() === mission.client.email;
    if (entrypoint === 'SUB_72_HOUR_MISSION_ASSESSMENT' && sameClient) return;
    throw fail(
      'MISSION_ID_ALREADY_REGISTERED',
      409,
      'This mission identifier is already registered and cannot be overwritten by the Sub-72 entry point.',
    );
  }

  const manifest = mission.manifest || {};
  const args = {
    p_id: mission.missionId,
    p_client_name: mission.client.name,
    p_client_email: mission.client.email,
    p_client_phone: mission.client.phone,
    p_booking_mode: 'SELF',
    p_status: 'PENDING_FEE',
    p_pax: mission.passengerCount,
    p_adults: safeInt(manifest.adults, mission.passengerCount),
    p_children: safeInt(manifest.children, 0),
    p_infants: safeInt(manifest.infants, 0),
    p_aircraft_class: mission.aircraft.class,
    p_estimated_lower: mission.estimateLower,
    p_estimated_upper: mission.estimateUpper,
    p_departure_airport: mission.departureAirport,
    p_destination_airport: mission.destinationAirport,
    p_etd: mission.departureAt.toISOString(),
    p_legs: mission.legs,
    p_raw_payload: {
      ...mission.originalPayload,
      sub72_assessment: {
        committed_at: committedAt.toISOString(),
        assessment_run_id: mission.assessmentRunId,
        entrypoint: 'SUB_72_HOUR_MISSION_ASSESSMENT',
        decision_engine: 'DATABASE_ONLY',
        payment_phase: 'PRE_PAYMENT',
        sourcing_state: 'PENDING_FEE',
        settlement_rail: mission.settlementRail,
        non_refundable_fee_acknowledged: Boolean(mission.feeAcknowledged),
        permit_responsibility_acknowledged: Boolean(mission.permitResponsibilityAcknowledged),
      },
    },
  };

  const response = await fetch(`${url}/rest/v1/rpc/upsert_mission_direct`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw await dbError(response, 'MISSION_PERSIST_FAILED');
}

export async function createStablecoinIntent(env, intent) {
  const { url, key } = credentials(env);
  const response = await fetch(`${url}/rest/v1/${STABLECOIN_INTENT_TABLE}`, {
    method: 'POST',
    headers: headers(key, { Prefer: 'return=representation' }),
    body: JSON.stringify(intent),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw await dbError(response, 'STABLECOIN_INTENT_FAILED');
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function dbError(response, fallbackCode) {
  const body = await response.text().catch(() => '');
  return fail(fallbackCode, 502, `${fallbackCode}: HTTP ${response.status} ${body.slice(0, 800)}`);
}

function safeInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function fail(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
