import { PERMIT_POLICY_NOTICE } from './database-assessment.js';

export async function dispatchAssessment(env, context) {
  const mission = context.mission || {};
  const client = mission.client || {};
  const routeSnapshot = context.databaseAssessment?.route_snapshot || {};
  const aircraftEval = context.databaseAssessment?.aircraft_evaluation || {};
  const decision = context.decision || {};
  const urgency = context.urgency || {};
  const publicResponse = context.publicResponse || {};
  const rawPayload = context.originalPayload || {};

  const refCode = mission.missionId || context.assessmentRunId;
  const departureIso = mission.departureAt instanceof Date
    ? mission.departureAt.toISOString()
    : String(mission.departureAt || urgency.departureAt || '');

  const aircraftLabel =
    typeof mission.aircraft === 'string'
      ? mission.aircraft
      : mission.aircraft?.model ||
        mission.aircraft?.requested_model ||
        mission.aircraft?.class ||
        mission.aircraft?.requested_class ||
        aircraftEval.requested_model ||
        aircraftEval.requested_class ||
        'VIP Jet';

  const feeAmount = publicResponse.sourcing_fee?.amount ?? 160;
  const feeCurrency = publicResponse.sourcing_fee?.currency || 'USD';
  const isGo = decision.decision === 'GO';
  const isCommitted = publicResponse.assessment_status === 'COMMITTED_PENDING_FEE';

  // Map Sub-72 workflow states into statuses the Comms Worker handles cleanly
  const commsStatus = !isGo
    ? 'REVIEW'
    : isCommitted
      ? 'REVIEW'
      : 'DEFAULT';

  const reason = !isGo
    ? (decision.reason_codes || []).join(', ') || 'DATABASE_ELIGIBILITY_CHECK'
    : 'SUB72_PENDING_FEE';

  const summaryMessage = !isGo
    ? `${publicResponse.summary || 'Route/parameters did not pass database suitability.'} ${PERMIT_POLICY_NOTICE}`
    : isCommitted
      ? `Mission ${refCode} is logged in PRE_PAYMENT (PENDING_FEE) for the flat $${feeAmount} ${feeCurrency} non-refundable Sub-72H sourcing fee. Live operator sourcing begins only after Strategic Authority verifies settlement. ${PERMIT_POLICY_NOTICE}`
      : `${publicResponse.summary || 'Sub-72H database suitability check completed.'} ${PERMIT_POLICY_NOTICE}`;

  const customizations = [
    ...(Array.isArray(rawPayload.customizations) ? rawPayload.customizations : []),
    `Lane: SUB-72H (${urgency.hoursToDeparture ?? 'N/A'}h to ETD)`,
    `Fee Policy: $${feeAmount} ${feeCurrency} Flat Non-Refundable`,
    'Permits: Client & Operator Responsibility (72h standard)',
  ];

  const enrichedMission = {
    request_id: refCode,
    ref_id: refCode,
    mission_id: mission.missionId || null,
    mission_id_scheme: '15D-SUB72-[4-5-ALNUM]',
    status: commsStatus,
    event_type: commsStatus,
    reason,
    message: summaryMessage,
    name: client.name || rawPayload.name || 'Valued Principal',
    email: client.email || rawPayload.email || '',
    phone: client.phone || rawPayload.phone || 'N/A',
    aircraft: aircraftLabel,
    passengers: mission.passengerCount ?? rawPayload.passengers ?? rawPayload.pax ?? 1,
    estimate_lower: mission.estimateLower ?? rawPayload.estimate_lower ?? null,
    estimate_upper: mission.estimateUpper ?? rawPayload.estimate_upper ?? null,
    legs: mission.legs || routeSnapshot.legs || [],
    customizations,
    payment_phase: 'PRE_PAYMENT',
    sourcing_state: 'PENDING_FEE',
    booking_mode: 'SELF',
    received_at: new Date().toISOString(),
    frontend_timestamp: rawPayload.timestamp || null,
    frontend_timestamptz: rawPayload.timestamptz || null,
    source: '15D_SUB72_DATABASE_ASSESSMENT',
    raw_payload: {
      ...rawPayload,
      request_id: refCode,
      ref_id: refCode,
      message: summaryMessage,
      customizations,
    },
    normalized: {
      client_name: client.name || rawPayload.name || 'Valued Principal',
      client_email: client.email || rawPayload.email || '',
      client_phone: client.phone || rawPayload.phone || 'N/A',
      aircraft_class: aircraftLabel,
      pax: mission.passengerCount ?? 1,
      manifest: mission.manifest || {},
      legs: mission.legs || routeSnapshot.legs || [],
      estimated_lower: mission.estimateLower ?? null,
      estimated_upper: mission.estimateUpper ?? null,
      departure_at: departureIso,
    },
    classification: routeSnapshot,
    jurisdiction: {
      route_classification: routeSnapshot.route_classification || 'UNKNOWN',
      sovereign_countries: routeSnapshot.sovereign_countries || [],
      airport_resolution_complete: Boolean(routeSnapshot.airport_resolution_complete),
      permit_assessment_performed: false,
      permit_responsibility: 'CLIENT_AND_OPERATOR',
      permit_policy_notice: PERMIT_POLICY_NOTICE,
    },
    processing: {
      pipeline: 'SUB_72_HOUR_DATABASE_ASSESSMENT',
      assessment_run_id: context.assessmentRunId,
      urgency_band: urgency.band || null,
      hours_to_departure: urgency.hoursToDeparture ?? null,
      assessment_status: publicResponse.assessment_status || null,
      assessment_version: publicResponse.assessment_version || null,
      decision_engine: 'DATABASE_ONLY',
      decision: decision.decision || null,
    },
    sub72_assessment: publicResponse,
  };

  const body = JSON.stringify(enrichedMission);
  const binding = env['noreply-wings'];
  let response;

  if (binding && typeof binding.fetch === 'function') {
    response = await binding.fetch(new Request('https://internal/dispatch-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }));
  } else {
    const endpoint = env.COMMS_DISPATCH_URL || 'https://noreply.15d.name.ng/dispatch-email';
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`Comms dispatch returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* Comms may return plain text. */ }
  return { ok: true, reference: parsed?.message_id || parsed?.id || null };
}
