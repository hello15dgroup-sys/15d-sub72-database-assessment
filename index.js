import { normalizePreflightPayload, normalizeIntakePayload } from './modules/mission-normalizer.js';
import { calculateUrgency } from './modules/urgency-engine.js';
import { assessFromDatabase } from './modules/database-assessment.js';
import {
  findAssessmentByIdempotency,
  findAssessmentByRunId,
  createAssessment,
  updateAssessment,
  persistCanonicalMission,
  createStablecoinIntent,
  checkAndRecordManualPaymentConfirmation,
} from './modules/assessment-store.js';
import { dispatchAssessment } from './modules/comms-dispatch.js';
import { buildPublicResponse } from './modules/response-builder.js';

const MAX_BODY_BYTES = 256 * 1024;
const ASSESSMENT_VERSION = '15D-SUB72-DATABASE-3.0';
const REQUEST_SCHEMA_VERSION = '15D-SUB72-REQUEST-2.0';
const IDEMPOTENCY_VERSION = 'DATABASE_V3';

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        service: '15D Sub-72-Hour Database Assessment',
        version: ASSESSMENT_VERSION,
        decision_engine: 'DATABASE_ONLY',
        external_ai: false,
      }, 200, cors);
    }

    const originCheck = validateOrigin(request, env);
    if (!originCheck.ok) return json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, 403, cors);

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'NOT_FOUND' }, 404, cors);
    }

    // Route 1: Stage-1 Suitability Check
    if (['/', '/assess', '/v1/sub-72-hour-mission-assessment'].includes(url.pathname)) {
      return handlePreflightAssessment(request, env, cors);
    }

    // Route 2: Stage-2 Client Intake & $160 Fee / Stablecoin Rail Commitment
    if (['/commit', '/v1/sub-72-hour-mission-commit'].includes(url.pathname)) {
      return handleIntakeCommitment(request, env, ctx, cors);
    }

    // Route 3: Manual Payment Confirmation Check
    if (['/confirm-payment', '/v1/sub-72-hour-mission-confirm-payment'].includes(url.pathname)) {
      return handleConfirmPayment(request, env, cors);
    }

    return json({ ok: false, error: 'NOT_FOUND' }, 404, cors);
  },
};

async function handlePreflightAssessment(request, env, cors) {
  const payload = await readJsonBody(request, cors);
  if (payload instanceof Response) return payload;

  const submittedAt = new Date();
  let preflight;
  let assessmentRunId;
  let assessmentCreated = false;

  try {
    preflight = normalizePreflightPayload(payload);
    const urgency = calculateUrgency(preflight.departureAt, submittedAt);
    assessmentRunId = createAssessmentRunId();

    const idempotencyKey = preflight.idempotencyKey
      ? `${preflight.idempotencyKey}:SUB72:${IDEMPOTENCY_VERSION}`
      : null;

    if (idempotencyKey) {
      const existing = await findAssessmentByIdempotency(env, idempotencyKey);
      if (existing?.frontend_response && Object.keys(existing.frontend_response).length) {
        return json(existing.frontend_response, 200, cors);
      }
    }

    await createAssessment(env, {
      assessment_run_id: assessmentRunId,
      mission_id: preflight.missionId || null,
      idempotency_key: idempotencyKey,
      assessment_status: 'RECEIVED',
      urgency_band: urgency.band,
      hours_to_departure: urgency.hoursToDeparture,
      departure_at: preflight.departureAt.toISOString(),
      submitted_at: submittedAt.toISOString(),
      schema_version: REQUEST_SCHEMA_VERSION,
      assessment_version: ASSESSMENT_VERSION,
      request_payload: payload,
      airfield_payload: {},
      intelligence_payload: { engine: 'DATABASE_ONLY', external_ai: false },
      evidence_payload: {},
      decision_payload: {},
      frontend_response: {},
      comms_status: 'NOT_DISPATCHED',
    });
    assessmentCreated = true;

    const databaseAssessment = await assessFromDatabase(env, preflight);

    const decision = {
      decision: databaseAssessment.decision,
      outcome: databaseAssessment.decision === 'GO' ? 'SOURCING_GO' : 'SOURCING_NO_GO',
      decision_basis: '15D_DATABASE_ONLY',
      reason_codes: databaseAssessment.reason_codes,
      blockers: databaseAssessment.blockers,
      advisories: databaseAssessment.advisories,
      eligible_aircraft: databaseAssessment.aircraft_evaluation.eligible_models,
      sourcing_activation_authorised: false,
      evaluated_at: new Date().toISOString(),
    };

    const publicResponse = buildPublicResponse({
      mission: preflight,
      urgency,
      assessmentRunId,
      databaseAssessment,
      decision,
      assessmentVersion: ASSESSMENT_VERSION,
      dossierUnlocked: false,
      env,
    });

    await updateAssessment(env, assessmentRunId, {
      assessment_status: 'COMPLETED',
      airfield_payload: databaseAssessment.route_snapshot,
      intelligence_payload: {
        engine: 'DATABASE_ONLY',
        external_ai: false,
        aircraft_evaluation: databaseAssessment.aircraft_evaluation,
      },
      evidence_payload: databaseAssessment.evidence,
      decision_payload: decision,
      frontend_response: publicResponse,
      completed_at: new Date().toISOString(),
    });

    return json(publicResponse, 200, cors);
  } catch (error) {
    console.error('SUB72_PREFLIGHT_ERROR', error?.stack || error?.message || error);
    if (assessmentCreated && assessmentRunId) {
      await updateAssessment(env, assessmentRunId, {
        assessment_status: 'FAILED',
        failure_code: error.code || 'ASSESSMENT_FAILED',
        failure_detail: String(error.message || error).slice(0, 1000),
        completed_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return json({
      ok: false,
      error: error.code || 'SUB72_ASSESSMENT_FAILED',
      message: safeErrorMessage(error),
      assessment_run_id: assessmentRunId || null,
    }, error.statusCode || 500, cors);
  }
}

async function handleIntakeCommitment(request, env, ctx, cors) {
  const payload = await readJsonBody(request, cors);
  if (payload instanceof Response) return payload;

  const committedAt = new Date();
  let intake;

  try {
    intake = normalizeIntakePayload(payload);
    const assessment = await findAssessmentByRunId(env, intake.assessmentRunId);
    if (!assessment) {
      return json({
        ok: false,
        error: 'ASSESSMENT_NOT_FOUND',
        message: 'No completed suitability check was found for this assessment_run_id.',
      }, 404, cors);
    }

    if (assessment.decision_payload?.decision !== 'GO') {
      return json({
        ok: false,
        error: 'ASSESSMENT_NOT_GO',
        message: 'Only missions with a completed GO suitability result can proceed to intake commitment.',
      }, 422, cors);
    }

    const urgency = calculateUrgency(assessment.departure_at, committedAt);

    await persistCanonicalMission(env, {
      ...intake,
      departureAt: new Date(assessment.departure_at),
      legs: assessment.airfield_payload?.legs || intake.legs,
      departureAirport: assessment.airfield_payload?.legs?.[0]?.from || intake.departureAirport,
      destinationAirport: assessment.airfield_payload?.legs?.at(-1)?.to || intake.destinationAirport,
      aircraft: {
        class: assessment.intelligence_payload?.aircraft_evaluation?.requested_class || intake.aircraft.class,
        model: assessment.intelligence_payload?.aircraft_evaluation?.requested_model || intake.aircraft.model || null,
      },
      assessmentRunId: intake.assessmentRunId,
      settlementRail: intake.settlementRail,
      feeAcknowledged: intake.nonRefundableFeeAcknowledged,
      permitResponsibilityAcknowledged: intake.permitResponsibilityAcknowledged,
    }, committedAt);

    let stablecoinIntent = null;
    if (intake.settlementRail === 'STABLECOIN' && intake.stablecoin) {
      stablecoinIntent = await createStablecoinIntent(env, {
        mission_id: intake.missionId,
        assessment_run_id: intake.assessmentRunId,
        direction: 'INBOUND_PAYMENT',
        asset_symbol: intake.stablecoin.asset,
        network: intake.stablecoin.network,
        wallet_address: intake.stablecoin.walletAddress,
        expected_amount_usd: Number(env.SUB72_FEE_AMOUNT || 160),
        tx_hash: intake.stablecoin.txHash || null,
        verification_status: 'PENDING_AUTHORITY_CHECK',
      });
    }

    const unlockedResponse = buildPublicResponse({
      mission: {
        missionId: intake.missionId,
        client: intake.client,
        aircraft: intake.aircraft,
        passengerCount: intake.passengerCount,
        manifest: intake.manifest,
        legs: assessment.airfield_payload?.legs || intake.legs,
        estimateLower: intake.estimateLower,
        estimateUpper: intake.estimateUpper,
        departureAt: new Date(assessment.departure_at),
      },
      urgency,
      assessmentRunId: intake.assessmentRunId,
      databaseAssessment: {
        route_snapshot: assessment.airfield_payload,
        aircraft_evaluation: assessment.intelligence_payload?.aircraft_evaluation || {},
        evidence: assessment.evidence_payload || {},
      },
      decision: assessment.decision_payload,
      assessmentVersion: ASSESSMENT_VERSION,
      dossierUnlocked: true,
      commitment: {
        mission_id: intake.missionId,
        payment_phase: 'PRE_PAYMENT',
        sourcing_state: 'PENDING_FEE',
        settlement_rail: intake.settlementRail,
        stablecoin_intent_id: stablecoinIntent?.intent_id || null,
        committed_at: committedAt.toISOString(),
      },
      env,
    });

    await updateAssessment(env, intake.assessmentRunId, {
      mission_id: intake.missionId,
      assessment_status: 'COMMITTED_PENDING_FEE',
      frontend_response: unlockedResponse,
    });

    const dispatchPromise = dispatchAssessment(env, {
      originalPayload: payload,
      mission: {
        missionId: intake.missionId,
        client: intake.client,
        aircraft: assessment.intelligence_payload?.aircraft_evaluation || intake.aircraft,
        passengerCount: intake.passengerCount,
        manifest: intake.manifest,
        legs: assessment.airfield_payload?.legs || [],
        estimateLower: intake.estimateLower,
        estimateUpper: intake.estimateUpper,
        departureAt: new Date(assessment.departure_at),
      },
      urgency,
      databaseAssessment: {
        route_snapshot: assessment.airfield_payload,
        aircraft_evaluation: assessment.intelligence_payload?.aircraft_evaluation || {},
        evidence: assessment.evidence_payload || {},
      },
      assessmentRunId: intake.assessmentRunId,
      decision: assessment.decision_payload,
      publicResponse: unlockedResponse,
    }).then(async result => {
      await updateAssessment(env, intake.assessmentRunId, {
        comms_status: result.ok ? 'DISPATCHED' : 'FAILED',
        comms_reference: result.reference || null,
      });
    }).catch(async error => {
      console.error('SUB72_COMMS_DISPATCH_FAILED', error?.message || error);
      await updateAssessment(env, intake.assessmentRunId, {
        comms_status: 'FAILED',
        failure_detail: `Comms dispatch failed: ${String(error?.message || error).slice(0, 500)}`,
      }).catch(() => {});
    });

    if (ctx?.waitUntil) ctx.waitUntil(dispatchPromise);
    else await dispatchPromise;

    return json(unlockedResponse, 200, cors);
  } catch (error) {
    console.error('SUB72_COMMIT_ERROR', error?.stack || error?.message || error);
    return json({
      ok: false,
      error: error.code || 'SUB72_COMMIT_FAILED',
      message: safeErrorMessage(error),
      mission_id: intake?.missionId || payload?.request_id || null,
      assessment_run_id: intake?.assessmentRunId || payload?.assessment_run_id || null,
    }, error.statusCode || 500, cors);
  }
}

async function handleConfirmPayment(request, env, cors) {
  const payload = await readJsonBody(request, cors);
  if (payload instanceof Response) return payload;

  const rawMissionId = payload?.mission_id ?? payload?.request_id ?? payload?.ref_id ?? '';
  const missionId = String(rawMissionId).trim().toUpperCase();
  const assessmentRunId = payload?.assessment_run_id ? String(payload.assessment_run_id).trim() : null;
  const settlementReference = payload?.settlement_reference ?? payload?.reference ?? null;
  const txHash = payload?.tx_hash ?? null;
  const rail = payload?.settlement_rail ?? payload?.rail ?? 'WIRE_OR_MANUAL';

  if (!missionId) {
    return json({
      ok: false,
      error: 'MISSING_MISSION_ID',
      message: 'mission_id (15D-SUB72-XXXX or 15D-SUB72-XXXXX) is required to confirm payment.',
    }, 400, cors);
  }

  try {
    const result = await checkAndRecordManualPaymentConfirmation(env, {
      missionId,
      assessmentRunId,
      settlementReference: settlementReference ? String(settlementReference).trim() : null,
      txHash: txHash ? String(txHash).trim() : null,
      rail: String(rail).trim().toUpperCase(),
    });

    const feeAmount = Number(env.SUB72_FEE_AMOUNT || 160);
    const feeCurrency = String(env.SUB72_FEE_CURRENCY || 'USD').toUpperCase();

    return json({
      ok: true,
      service: 'SUB_72_HOUR_DATABASE_ASSESSMENT',
      mission_id: result.mission_id,
      assessment_run_id: assessmentRunId,
      payment_verified: result.verified,
      verification_state: result.state,
      fee_amount: feeAmount,
      fee_currency: feeCurrency,
      refundable: false,
      database_check: result,
      message: result.verified
        ? `Confirmed in database: the $${feeAmount} ${feeCurrency} Sub-72H fee for ${result.mission_id} is verified.`
        : `Payment confirmation logged for ${result.mission_id}, but the $${feeAmount} ${feeCurrency} fee is not yet marked verified in the database. Strategic Authority verification is still required.`,
    }, 200, cors);
  } catch (error) {
    console.error('SUB72_CONFIRM_PAYMENT_ERROR', error?.stack || error?.message || error);
    return json({
      ok: false,
      error: error.code || 'CONFIRM_PAYMENT_FAILED',
      message: safeErrorMessage(error),
      mission_id: missionId || null,
    }, error.statusCode || 500, cors);
  }
}

async function readJsonBody(request, cors) {
  let rawText;
  try {
    rawText = await request.text();
    if (new TextEncoder().encode(rawText).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: 'PAYLOAD_TOO_LARGE', max_bytes: MAX_BODY_BYTES }, 413, cors);
    }
  } catch {
    return json({ ok: false, error: 'REQUEST_READ_FAILED' }, 400, cors);
  }

  try {
    return JSON.parse(rawText);
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400, cors);
  }
}

function createAssessmentRunId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `15D-SUB72-${suffix}`;
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  const allowOrigin = allowed.length ? (allowed.includes(origin) ? origin : 'null') : '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, X-Request-ID',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function validateOrigin(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  if (!allowed.length || !origin) return { ok: true };
  return { ok: allowed.includes(origin) };
}

function json(value, status, cors) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}

function safeErrorMessage(error) {
  const known = {
    INVALID_MISSION_PAYLOAD: 'The submitted mission details are incomplete or invalid.',
    INVALID_SUB72_MISSION_ID: 'Sub-72 mission IDs must match 15D-SUB72-XXXX or 15D-SUB72-XXXXX.',
    NOT_A_SUB72_MISSION: 'This departure is outside the Sub-72-hour assessment window.',
    FEE_ACKNOWLEDGEMENT_REQUIRED: 'You must acknowledge the flat non-refundable $160 Sub-72-hour sourcing fee before proceeding.',
    MISSION_ID_ALREADY_REGISTERED: 'This mission reference is already registered and was not overwritten.',
    SUPABASE_CONFIG_MISSING: 'Database assessment is not configured.',
    DATABASE_QUERY_FAILED: 'The 15D aviation database could not be read. No GO decision has been issued.',
    MISSION_PERSIST_FAILED: 'The canonical mission record could not be saved.',
    ASSESSMENT_CREATE_FAILED: 'The assessment audit record could not be created.',
  };
  return known[error.code] || 'The database assessment could not be completed. No sourcing authorisation has been issued.';
}
