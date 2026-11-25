export function buildPublicResponse({ mission, urgency, assessmentRunId, databaseAssessment, decision, assessmentVersion, env }) {
  const sameDay = urgency.band === 'LANE_B';
  const feeAmount = sameDay ? parseOptionalAmount(env.SUB72_LANE_B_FEE_AMOUNT || env.SUB72_SAME_DAY_FEE_AMOUNT) : null;
  const feeCurrency = String(env.SUB72_FEE_CURRENCY || 'USD').toUpperCase();
  const isGo = decision.decision === 'GO';

  return {
    ok: true,
    schema_version: '15D-SUB72-DATABASE-RESPONSE-2.0',
    service: 'SUB_72_HOUR_DATABASE_ASSESSMENT',
    mission_id: mission.missionId,
    assessment_run_id: assessmentRunId,
    assessment_status: 'COMPLETED',
    assessment_version: assessmentVersion,
    decision_engine: 'DATABASE_ONLY',
    decision: decision.decision,
    outcome: decision.outcome,
    summary: isGo
      ? 'The mission passed the configured database eligibility checks. This is a preliminary database result, not operational clearance.'
      : 'The mission did not pass one or more database eligibility checks. Review the reason codes below.',
    urgency: {
      band: urgency.band,
      hours_to_departure: urgency.hoursToDeparture,
      departure_at: mission.departureAt.toISOString(),
    },
    route: databaseAssessment.route_snapshot,
    aircraft: {
      requested_class: databaseAssessment.aircraft_evaluation.requested_class,
      requested_model: databaseAssessment.aircraft_evaluation.requested_model,
      eligible_models: databaseAssessment.aircraft_evaluation.eligible_models,
      fleet_records: databaseAssessment.aircraft_evaluation.fleet_records,
      fleet_records_are_informational_only: true,
    },
    reason_codes: decision.reason_codes,
    blockers: decision.blockers,
    evidence: databaseAssessment.evidence,
    permissions: {
      database_eligibility: isGo,
      fee_collection_before_assessment: false,
      sourcing_activation_authorised: false,
      flight_release_authorised: false,
    },
    sourcing_fee: {
      applies_to_same_day_lane: sameDay && isGo,
      configured: sameDay && feeAmount !== null,
      amount: sameDay && isGo ? feeAmount : null,
      currency: feeCurrency,
      payment_timing: 'AFTER_GO_BEFORE_ACTIVE_SOURCING',
      required_to_receive_go_or_no_go: false,
      collectible_after_go: sameDay && isGo && feeAmount !== null,
      collection_implemented_by_this_worker: false,
    },
    next_action: !isGo
      ? 'MISSION_CANNOT_PROCEED_UNDER_DATABASE_RULES'
      : sameDay && feeAmount !== null
        ? 'SOURCING_FEE_MAY_BE_COLLECTED_BEFORE_ACTIVE_SOURCING'
        : 'SEPARATE_SOURCING_ACTIVATION_GATE_REQUIRED',
    evaluated_at: decision.evaluated_at,
  };
}

function parseOptionalAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
