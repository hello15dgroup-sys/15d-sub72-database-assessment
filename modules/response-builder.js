import { PERMIT_POLICY_NOTICE } from './database-assessment.js';
import { generateSub72MissionId } from './mission-normalizer.js';

const DEFAULT_SUB72_FEE_USD = 160;

export function buildPublicResponse({
  mission,
  urgency,
  assessmentRunId,
  databaseAssessment,
  decision,
  assessmentVersion,
  dossierUnlocked = false,
  commitment = null,
  env = {},
}) {
  const isGo = decision?.decision === 'GO';
  const feeAmount = resolveSub72FeeAmount(env);
  const feeCurrency = String(env.SUB72_FEE_CURRENCY || 'USD').toUpperCase();
  const missionId = mission?.missionId || commitment?.mission_id || null;
  const previewMissionId = missionId || (isGo ? generateSub72MissionId(5) : null);
  const departureIso = mission?.departureAt instanceof Date
    ? mission.departureAt.toISOString()
    : String(mission?.departureAt || urgency?.departureAt || '');

  const advisories = Array.isArray(decision?.advisories) ? decision.advisories : [];
  const routeSnapshot = databaseAssessment?.route_snapshot || {};
  const aircraftEval = databaseAssessment?.aircraft_evaluation || {};
  const evidence = databaseAssessment?.evidence || {};

  const gatedRoute = dossierUnlocked
    ? routeSnapshot
    : {
        route_classification: routeSnapshot.route_classification || 'UNKNOWN',
        sovereign_countries: routeSnapshot.sovereign_countries || [],
        airport_resolution_complete: Boolean(routeSnapshot.airport_resolution_complete),
        permit_assessment_performed: false,
        permit_responsibility: 'CLIENT_AND_OPERATOR',
        leg_count: Array.isArray(routeSnapshot.legs) ? routeSnapshot.legs.length : 0,
        dossier_locked: true,
      };

  const gatedAircraft = dossierUnlocked
    ? {
        requested_class: aircraftEval.requested_class || null,
        requested_model: aircraftEval.requested_model || null,
        eligible_models: aircraftEval.eligible_models || [],
        fleet_records: aircraftEval.fleet_records || [],
        fleet_records_are_informational_only: true,
      }
    : {
        requested_class: aircraftEval.requested_class || null,
        requested_model: aircraftEval.requested_model || null,
        eligible_model_count: Array.isArray(aircraftEval.eligible_models) ? aircraftEval.eligible_models.length : 0,
        dossier_locked: true,
      };

  const gatedEvidence = dossierUnlocked
    ? evidence
    : {
        decision_engine: evidence.decision_engine || 'DATABASE_ONLY',
        retrieved_at: evidence.retrieved_at || null,
        permit_policy_notice: PERMIT_POLICY_NOTICE,
        dossier_locked: true,
        unlock_requirement: 'COMPLETE_INTAKE_AND_INITIATE_160_USD_FEE',
        limitations: evidence.limitations || [PERMIT_POLICY_NOTICE],
      };

  return {
    ok: true,
    schema_version: '15D-SUB72-DATABASE-RESPONSE-3.0',
    service: 'SUB_72_HOUR_DATABASE_ASSESSMENT',
    mission_id: missionId,
    preview_mission_id: previewMissionId,
    mission_id_format: '15D-SUB72-[4-5-ALNUM]',
    assessment_run_id: assessmentRunId,
    assessment_status: commitment ? 'COMMITTED_PENDING_FEE' : 'COMPLETED',
    assessment_version: assessmentVersion,
    decision_engine: 'DATABASE_ONLY',
    decision: decision.decision,
    outcome: decision.outcome,
    dossier_unlocked: Boolean(dossierUnlocked),
    summary: isGo
      ? dossierUnlocked
        ? 'Mission committed in PRE_PAYMENT (PENDING_FEE) with full suitability dossier unlocked. Complete the flat $160.00 non-refundable Sub-72H sourcing fee to initiate live operator sourcing.'
        : 'Route and parameters cleared the 15D database suitability check. Submit client details and initiate the flat $160.00 non-refundable Sub-72H fee to unlock the full dossier and lock your mission slot.'
      : 'The mission did not pass one or more database eligibility checks. Review the reason codes below.',
    urgency: {
      band: urgency.band,
      hours_to_departure: urgency.hoursToDeparture,
      departure_at: departureIso,
    },
    permit_policy: {
      assessed_by_15d_wings: false,
      standard_lead_time_hours: 72,
      responsibility: 'CLIENT_AND_OPERATOR',
      notice: PERMIT_POLICY_NOTICE,
    },
    route: gatedRoute,
    aircraft: gatedAircraft,
    reason_codes: decision.reason_codes || [],
    blockers: decision.blockers || [],
    advisories,
    evidence: gatedEvidence,
    commitment,
    permissions: {
      database_eligibility: isGo,
      dossier_unlocked: Boolean(dossierUnlocked),
      fee_collection_before_assessment: false,
      sourcing_activation_authorised: false,
      flight_release_authorised: false,
    },
    sourcing_fee: {
      applies_to_sub72_lane: isGo,
      flat_rate: true,
      refundable: false,
      amount: isGo ? feeAmount : null,
      currency: feeCurrency,
      payment_timing: 'AFTER_GO_BEFORE_ACTIVE_SOURCING',
      required_to_receive_go_or_no_go: false,
      collectible_after_go: isGo && !commitment,
      collection_stage: 'BOOKING_INTAKE_COMMIT',
    },
    next_action: !isGo
      ? 'MISSION_CANNOT_PROCEED_UNDER_DATABASE_RULES'
      : !dossierUnlocked
        ? 'SUBMIT_CLIENT_DETAILS_AND_160_USD_NON_REFUNDABLE_FEE'
        : 'AWAIT_STRATEGIC_AUTHORITY_FEE_VERIFICATION',
    evaluated_at: decision.evaluated_at,
  };
}

function resolveSub72FeeAmount(env) {
  const raw = env.SUB72_FEE_AMOUNT ?? env.SUB72_LANE_B_FEE_AMOUNT ?? env.SUB72_SAME_DAY_FEE_AMOUNT;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SUB72_FEE_USD;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount >= 0 ? amount : DEFAULT_SUB72_FEE_USD;
}
