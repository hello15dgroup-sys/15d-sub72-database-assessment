import { isValidSub72MissionId } from './mission-normalizer.js';

const DEFAULT_SUPABASE_URL = 'https://mhplukffgcxiorpfunyy.supabase.co';
const ASSESSMENT_TABLE = 'sub_72_hour_mission_assessments';
const STABLECOIN_INTENT_TABLE = 'stablecoin_settlement_intents';
const PREFLIGHT_PLACEHOLDER_EMAIL = 'pending-intake@15dwings.com.ng';

const ALLOWED_ASSESSMENT_STATUSES = new Set([
  'RECEIVED',
  'RESEARCHING',
  'ASSESSING',
  'COMPLETED',
  'FAILED',
  'HUMAN_REVIEW_REQUIRED',
]);

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

function sanitizeAssessmentStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  if (ALLOWED_ASSESSMENT_STATUSES.has(normalized)) return normalized;
  if (normalized.startsWith('COMMITTED') || normalized.startsWith('FEE_') || normalized.startsWith('PAYMENT_')) {
    return 'COMPLETED';
  }
  return 'ASSESSING';
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
  if (!record.mission_id || !isValidSub72MissionId(record.mission_id)) {
    throw fail(
      'INVALID_SUB72_MISSION_ID',
      400,
      'mission_id is required and must match 15D-SUB72-XXXX or 15D-SUB72-XXXXX.',
    );
  }
  const safeRecord = {
    ...record,
    assessment_status: sanitizeAssessmentStatus(record.assessment_status),
  };
  const { url, key } = credentials(env);
  const response = await fetch(`${url}/rest/v1/${ASSESSMENT_TABLE}`, {
    method: 'POST',
    headers: headers(key, { Prefer: 'return=representation' }),
    body: JSON.stringify(safeRecord),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw await dbError(response, 'ASSESSMENT_CREATE_FAILED');
}

export async function updateAssessment(env, assessmentRunId, patch) {
  if (patch.mission_id && !isValidSub72MissionId(patch.mission_id)) {
    throw fail(
      'INVALID_SUB72_MISSION_ID',
      400,
      'mission_id must match 15D-SUB72-XXXX or 15D-SUB72-XXXXX.',
    );
  }
  const safePatch = { ...patch, updated_at: new Date().toISOString() };
  if (safePatch.assessment_status) {
    safePatch.assessment_status = sanitizeAssessmentStatus(safePatch.assessment_status);
  }
  const { url, key } = credentials(env);
  const params = new URLSearchParams({ assessment_run_id: `eq.${assessmentRunId}` });
  const response = await fetch(`${url}/rest/v1/${ASSESSMENT_TABLE}?${params}`, {
    method: 'PATCH',
    headers: headers(key, { Prefer: 'return=minimal' }),
    body: JSON.stringify(safePatch),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw await dbError(response, 'ASSESSMENT_UPDATE_FAILED');
}

export async function persistCanonicalMission(env, mission, committedAt) {
  if (!isValidSub72MissionId(mission.missionId)) {
    throw fail(
      'INVALID_SUB72_MISSION_ID',
      400,
      'Sub-72 canonical mission IDs must match 15D-SUB72-XXXX or 15D-SUB72-XXXXX.',
    );
  }

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
    const existingEmail = String(existing.client_email || '').toLowerCase();
    const isPreflightPlaceholder = existingEmail === PREFLIGHT_PLACEHOLDER_EMAIL;
    const sameClient =
      isPreflightPlaceholder ||
      !mission.client?.email ||
      existingEmail === mission.client.email;

    if (entrypoint === 'SUB_72_HOUR_MISSION_ASSESSMENT' && sameClient) {
      if (!isPreflightPlaceholder) return;
      // Upgrade the Stage-1 preflight placeholder row into the committed client mission.
    } else {
      throw fail(
        'MISSION_ID_ALREADY_REGISTERED',
        409,
        'This mission identifier is already registered and cannot be overwritten by the Sub-72 entry point.',
      );
    }
  }

  const manifest = mission.manifest || {};
  const isCommitted = Boolean(mission.client?.name && mission.client?.email);
  const args = {
    p_id: mission.missionId,
    p_client_name: mission.client?.name || 'Pending Intake',
    p_client_email: mission.client?.email || PREFLIGHT_PLACEHOLDER_EMAIL,
    p_client_phone: mission.client?.phone || null,
    p_booking_mode: 'SELF',
    p_status: isCommitted ? 'PENDING_FEE' : 'PREFLIGHT_ASSESSMENT',
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
        mission_id_scheme: '15D-SUB72-[4-5-ALNUM]',
        committed_at: committedAt.toISOString(),
        assessment_run_id: mission.assessmentRunId || null,
        entrypoint: 'SUB_72_HOUR_MISSION_ASSESSMENT',
        decision_engine: 'DATABASE_ONLY',
        payment_phase: 'PRE_PAYMENT',
        sourcing_state: isCommitted ? 'PENDING_FEE' : 'PREFLIGHT_ONLY',
        settlement_rail: mission.settlementRail || null,
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
  if (intent.mission_id && !isValidSub72MissionId(intent.mission_id)) {
    throw fail(
      'INVALID_SUB72_MISSION_ID',
      400,
      'mission_id must match 15D-SUB72-XXXX or 15D-SUB72-XXXXX.',
    );
  }
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

export async function checkAndRecordManualPaymentConfirmation(env, {
  missionId,
  assessmentRunId = null,
  settlementReference = null,
  txHash = null,
  rail = 'WIRE_OR_MANUAL',
}) {
  if (!isValidSub72MissionId(missionId)) {
    throw fail(
      'INVALID_SUB72_MISSION_ID',
      400,
      'mission_id must match 15D-SUB72-XXXX or 15D-SUB72-XXXXX.',
    );
  }

  const { url, key } = credentials(env);
  const params = new URLSearchParams({
    id: `eq.${missionId}`,
    select: 'id,status,payment_status,payment_verified,payment_verified_at,raw_payload',
    limit: '1',
  });

  const missionRes = await fetch(`${url}/rest/v1/missions?${params}`, {
    headers: headers(key),
    signal: AbortSignal.timeout(15_000),
  });
  if (!missionRes.ok) throw await dbError(missionRes, 'MISSION_LOOKUP_FAILED');
  const rows = await missionRes.json();
  const missionRow = Array.isArray(rows) ? rows[0] || null : null;

  if (!missionRow) {
    return {
      found: false,
      verified: false,
      state: 'MISSION_NOT_FOUND',
      mission_id: missionId,
    };
  }

  const rawMeta = missionRow.raw_payload?.sub72_assessment || {};
  const verified = Boolean(
    missionRow.payment_verified === true ||
    ['VERIFIED', 'PAID', 'SETTLED'].includes(String(missionRow.payment_status || '').toUpperCase()) ||
    rawMeta.fee_verified === true,
  );

  const confirmedAt = new Date().toISOString();
  const updatedRawPayload = {
    ...(missionRow.raw_payload || {}),
    sub72_assessment: {
      ...rawMeta,
      manual_payment_claim_submitted_at: confirmedAt,
      manual_payment_rail: rail,
      manual_settlement_reference: settlementReference || rawMeta.manual_settlement_reference || null,
      manual_tx_hash: txHash || rawMeta.manual_tx_hash || null,
      fee_verified: verified,
    },
  };

  await fetch(`${url}/rest/v1/missions?${new URLSearchParams({ id: `eq.${missionId}` })}`, {
    method: 'PATCH',
    headers: headers(key, { Prefer: 'return=minimal' }),
    body: JSON.stringify({
      raw_payload: updatedRawPayload,
      payment_status: verified
        ? (missionRow.payment_status || 'VERIFIED')
        : (missionRow.payment_status || 'PENDING_VERIFICATION'),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (assessmentRunId) {
    await updateAssessment(env, assessmentRunId, {
      assessment_status: verified ? 'COMPLETED' : 'HUMAN_REVIEW_REQUIRED',
    }).catch(() => {});
  }

  return {
    found: true,
    verified,
    state: verified ? 'PAYMENT_VERIFIED' : 'AWAITING_AUTHORITY_VERIFICATION',
    mission_id: missionId,
    mission_status: missionRow.status || null,
    payment_status: verified ? 'VERIFIED' : 'PENDING_VERIFICATION',
    payment_verified_at: missionRow.payment_verified_at || null,
    settlement_reference: settlementReference || null,
    tx_hash: txHash || null,
    checked_at: confirmedAt,
  };
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
