import { normalizeMissionPayload } from './modules/mission-normalizer.js';
import { calculateUrgency } from './modules/urgency-engine.js';
import { assessFromDatabase } from './modules/database-assessment.js';
import {
  findAssessmentByIdempotency,
  persistCanonicalMission,
  createAssessment,
  updateAssessment,
} from './modules/assessment-store.js';
import { dispatchAssessment } from './modules/comms-dispatch.js';
import { buildPublicResponse } from './modules/response-builder.js';

const MAX_BODY_BYTES = 256 * 1024;
const ASSESSMENT_VERSION = '15D-SUB72-DATABASE-2.0';
const REQUEST_SCHEMA_VERSION = '15D-SUB72-REQUEST-1.0';
const IDEMPOTENCY_VERSION = 'DATABASE_V2';

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

    if (request.method !== 'POST' || !['/', '/assess', '/v1/sub-72-hour-mission-assessment'].includes(url.pathname)) {
      return json({ ok: false, error: 'NOT_FOUND' }, 404, cors);
    }

    const originCheck = validateOrigin(request, env);
    if (!originCheck.ok) return json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, 403, cors);

    let rawText;
    try {
      rawText = await request.text();
      if (new TextEncoder().encode(rawText).byteLength > MAX_BODY_BYTES) {
        return json({ ok: false, error: 'PAYLOAD_TOO_LARGE', max_bytes: MAX_BODY_BYTES }, 413, cors);
      }
    } catch {
      return json({ ok: false, error: 'REQUEST_READ_FAILED' }, 400, cors);
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return json({ ok: false, error: 'INVALID_JSON' }, 400, cors);
    }

    const submittedAt = new Date();
    let mission;
    let assessmentRunId;
    let assessmentCreated = false;

    try {
      mission = normalizeMissionPayload(payload);
      const urgency = calculateUrgency(mission.departureAt, submittedAt);
      assessmentRunId = createAssessmentRunId();

      const idempotencyKey = `${mission.missionId}:SUB72:${IDEMPOTENCY_VERSION}`;
      const existing = await findAssessmentByIdempotency(env, idempotencyKey);
      if (existing) {
        if (existing.frontend_response && Object.keys(existing.frontend_response).length) {
          return json(existing.frontend_response, 200, cors);
        }
        return json({
          ok: false,
          error: 'ASSESSMENT_ALREADY_ATTEMPTED',
          mission_id: mission.missionId,
          assessment_run_id: existing.assessment_run_id,
          assessment_status: existing.assessment_status,
          message: 'An assessment attempt already exists for this mission reference. Contact 15D Wings if it did not complete.',
        }, 409, cors);
      }

      // Preserve the canonical missions-table integration used by the original Sub-72 entry point.
      // Existing non-Sub-72 missions are never overwritten.
      await persistCanonicalMission(env, mission, submittedAt);

      await createAssessment(env, {
        assessment_run_id: assessmentRunId,
        mission_id: mission.missionId,
        idempotency_key: idempotencyKey,
        assessment_status: 'RECEIVED',
        urgency_band: urgency.band,
        hours_to_departure: urgency.hoursToDeparture,
        departure_at: mission.departureAt.toISOString(),
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

      const databaseAssessment = await assessFromDatabase(env, mission);

      await updateAssessment(env, assessmentRunId, {
        assessment_status: 'ASSESSING',
        airfield_payload: databaseAssessment.route_snapshot,
        intelligence_payload: {
          engine: 'DATABASE_ONLY',
          external_ai: false,
          aircraft_evaluation: databaseAssessment.aircraft_evaluation,
        },
        evidence_payload: databaseAssessment.evidence,
      });

      const decision = {
        decision: databaseAssessment.decision,
        outcome: databaseAssessment.decision === 'GO' ? 'SOURCING_GO' : 'SOURCING_NO_GO',
        decision_basis: '15D_DATABASE_ONLY',
        reason_codes: databaseAssessment.reason_codes,
        blockers: databaseAssessment.blockers,
        eligible_aircraft: databaseAssessment.aircraft_evaluation.eligible_models,
        sourcing_activation_authorised: false,
        evaluated_at: new Date().toISOString(),
      };

      const publicResponse = buildPublicResponse({
        mission,
        urgency,
        assessmentRunId,
        databaseAssessment,
        decision,
        assessmentVersion: ASSESSMENT_VERSION,
        env,
      });

      await updateAssessment(env, assessmentRunId, {
        assessment_status: 'COMPLETED',
        decision_payload: decision,
        frontend_response: publicResponse,
        completed_at: new Date().toISOString(),
      });

      // The GO/NO-GO result is persisted and returned before any optional sourcing-fee step.
      // Comms is a notification side-effect and cannot change the decision.
      const dispatchPromise = dispatchAssessment(env, {
        originalPayload: payload,
        mission,
        urgency,
        databaseAssessment,
        assessmentRunId,
        decision,
        publicResponse,
      }).then(async result => {
        await updateAssessment(env, assessmentRunId, {
          comms_status: result.ok ? 'DISPATCHED' : 'FAILED',
          comms_reference: result.reference || null,
        });
      }).catch(async error => {
        console.error('SUB72_COMMS_DISPATCH_FAILED', error?.message || error);
        await updateAssessment(env, assessmentRunId, {
          comms_status: 'FAILED',
          failure_detail: `Comms dispatch failed: ${String(error?.message || error).slice(0, 500)}`,
        }).catch(() => {});
      });

      if (ctx?.waitUntil) ctx.waitUntil(dispatchPromise);
      else await dispatchPromise;

      return json(publicResponse, 200, cors);
    } catch (error) {
      console.error('SUB72_DATABASE_ASSESSMENT_ERROR', error?.stack || error?.message || error);
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
        mission_id: mission?.missionId || payload?.request_id || null,
        assessment_run_id: assessmentRunId || null,
      }, error.statusCode || 500, cors);
    }
  },
};

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
    NOT_A_SUB72_MISSION: 'This departure is outside the Sub-72-hour assessment window.',
    MISSION_ID_ALREADY_REGISTERED: 'This mission reference is already registered and was not overwritten.',
    SUPABASE_CONFIG_MISSING: 'Database assessment is not configured.',
    DATABASE_QUERY_FAILED: 'The 15D aviation database could not be read. No GO decision has been issued.',
    MISSION_PERSIST_FAILED: 'The canonical mission record could not be saved.',
    ASSESSMENT_CREATE_FAILED: 'The assessment audit record could not be created.',
  };
  return known[error.code] || 'The database assessment could not be completed. No sourcing authorisation has been issued.';
}
