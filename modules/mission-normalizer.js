const SUB72_MISSION_ID_RE = /^15D-SUB72-[A-Z0-9]{4,5}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFSET_ISO_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const ALLOWED_RAILS = new Set(['STABLECOIN', 'BANK_TRANSFER', 'CARD']);
const ALLOWED_ASSETS = new Set(['USDC', 'USDT']);
const ALLOWED_NETWORKS = new Set(['TRON_TRC20', 'ETHEREUM_ERC20', 'POLYGON', 'SOLANA', 'BASE']);
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Generates a Sub-72 audit-distinct mission ID:
 * 15D-SUB72- followed by 4 or 5 random alphanumeric symbols.
 */
export function generateSub72MissionId(length = 5) {
  const safeLength = length === 4 || length === 5 ? length : 5;
  const bytes = new Uint8Array(safeLength);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (let i = 0; i < safeLength; i += 1) {
    suffix += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return `15D-SUB72-${suffix}`;
}

export function isValidSub72MissionId(value) {
  return SUB72_MISSION_ID_RE.test(cleanCode(value));
}

/**
 * Stage 1 (/assess): Validates route + departure time + aircraft/passenger inputs
 * without forcing full client contact/manifest or registering a mission early.
 */
export function normalizePreflightPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Request body must be a JSON object.');
  }

  const legs = extractLegs(payload);
  const departureAt = new Date(legs[0].departure_timestamptz);
  const aircraft = normalizeAircraft(payload.aircraft ?? payload.aircraft_class ?? payload.aircraftClass ?? 'UNSPECIFIED');
  const manifest = isPlainObject(payload.manifest) ? payload.manifest : {};
  const passengerCount = getPassengerCount(payload, manifest);

  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 525) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Passenger count must be between 1 and 525.');
  }

  const estimateLower = finiteOrNull(payload.estimate_lower ?? payload.total_estimate);
  const estimateUpper = finiteOrNull(payload.estimate_upper);
  if (estimateLower !== null && estimateLower < 0) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Estimate cannot be negative.');
  }
  if (estimateUpper !== null && estimateLower !== null && estimateUpper < estimateLower) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'estimate_upper cannot be lower than estimate_lower.');
  }

  const rawMissionId = payload.request_id ?? payload.ref_id ?? payload.mission_id ?? null;
  let missionId = null;
  if (rawMissionId) {
    missionId = cleanCode(rawMissionId);
    if (!SUB72_MISSION_ID_RE.test(missionId)) {
      throw fail(
        'INVALID_MISSION_PAYLOAD',
        400,
        'Sub-72 mission identifiers must follow 15D-SUB72-XXXX or 15D-SUB72-XXXXX.',
      );
    }
  }

  const idempotencyKey = payload.idempotency_key
    ? String(payload.idempotency_key).trim()
    : missionId || null;

  return {
    missionId,
    idempotencyKey,
    client: {
      name: payload.name ? String(payload.name).trim() : null,
      email: payload.email ? String(payload.email).trim().toLowerCase() : null,
      phone: payload.phone ? String(payload.phone).trim() : null,
    },
    aircraft,
    passengerCount,
    manifest,
    legs,
    departureAt,
    departureAirport: legs[0].from,
    destinationAirport: legs[legs.length - 1].to,
    estimateLower,
    estimateUpper,
    originalPayload: payload,
  };
}

/**
 * Stage 2 (/commit): Validates assessment_run_id, canonical 15D-SUB72-[4-5 chars] missionId,
 * client contact/manifest, fee & permit responsibility acknowledgements, and optional payment/stablecoin intent.
 */
export function normalizeIntakePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Request body must be a JSON object.');
  }

  const assessmentRunId = String(payload.assessment_run_id ?? payload.assessmentRunId ?? '').trim();
  if (!assessmentRunId) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Missing required field: assessment_run_id');
  }

  for (const key of ['name', 'email']) {
    if (payload[key] === undefined || payload[key] === null || String(payload[key]).trim() === '') {
      throw fail('INVALID_MISSION_PAYLOAD', 400, `Missing required field: ${key}`);
    }
  }

  const rawReqId = payload.request_id ?? payload.mission_id ?? null;
  const rawRefId = payload.ref_id ?? rawReqId ?? null;
  const missionId = rawReqId ? cleanCode(rawReqId) : generateSub72MissionId(5);
  const refId = rawRefId ? cleanCode(rawRefId) : missionId;

  if (!SUB72_MISSION_ID_RE.test(missionId) || refId !== missionId) {
    throw fail(
      'INVALID_MISSION_PAYLOAD',
      400,
      'request_id and ref_id must match the 15D-SUB72-XXXX or 15D-SUB72-XXXXX format.',
    );
  }

  const missionUuid = payload.mission_uuid ?? payload.missionUuid ?? null;
  if (missionUuid !== null && missionUuid !== '' && !UUID_RE.test(String(missionUuid).trim())) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'mission_uuid must be a valid UUID when provided.');
  }

  const name = String(payload.name).trim();
  const email = String(payload.email).trim().toLowerCase();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'A client name and valid email are required.');
  }

  const feeAcknowledged = Boolean(
    payload.non_refundable_fee_acknowledged ??
    payload.fee_acknowledged ??
    payload.feeAcknowledged ??
    false,
  );
  if (!feeAcknowledged) {
    throw fail(
      'FEE_ACKNOWLEDGEMENT_REQUIRED',
      422,
      'You must acknowledge the flat non-refundable $160 Sub-72-hour sourcing fee before proceeding.',
    );
  }

  const permitResponsibilityAcknowledged = Boolean(
    payload.permit_responsibility_acknowledged ??
    payload.permitResponsibilityAcknowledged ??
    true,
  );

  const settlementRail = cleanCode(payload.settlement_rail ?? payload.settlementRail ?? 'BANK_TRANSFER');
  if (!ALLOWED_RAILS.has(settlementRail)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'settlement_rail must be STABLECOIN, BANK_TRANSFER, or CARD.');
  }

  let stablecoin = null;
  if (settlementRail === 'STABLECOIN') {
    const rawSc = isPlainObject(payload.stablecoin) ? payload.stablecoin : payload;
    const asset = cleanCode(rawSc.asset ?? rawSc.asset_symbol ?? rawSc.stablecoin_asset ?? 'USDC');
    const network = cleanCode(rawSc.network ?? rawSc.stablecoin_network ?? '');
    const walletAddress = String(rawSc.wallet_address ?? rawSc.walletAddress ?? rawSc.client_wallet_address ?? '').trim();
    const txHashRaw = rawSc.tx_hash ?? rawSc.txHash ?? rawSc.tx_hash_submitted ?? null;
    const txHash = txHashRaw ? String(txHashRaw).trim() : null;

    if (!ALLOWED_ASSETS.has(asset)) {
      throw fail('INVALID_MISSION_PAYLOAD', 400, 'stablecoin asset must be USDC or USDT.');
    }
    if (!ALLOWED_NETWORKS.has(network)) {
      throw fail('INVALID_MISSION_PAYLOAD', 400, 'stablecoin network must be TRON_TRC20, ETHEREUM_ERC20, POLYGON, SOLANA, or BASE.');
    }
    if (!walletAddress || walletAddress.length < 16 || walletAddress.length > 128) {
      throw fail('INVALID_MISSION_PAYLOAD', 400, 'A valid stablecoin wallet_address is required when settlement_rail is STABLECOIN.');
    }

    stablecoin = { asset, network, walletAddress, txHash };
  }

  const manifest = isPlainObject(payload.manifest) ? payload.manifest : {};
  const passengerCount = getPassengerCount(payload, manifest);
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 525) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Passenger count must be between 1 and 525.');
  }

  const legs = Array.isArray(payload.legs) && payload.legs.length
    ? payload.legs.map(normalizeLeg)
    : [];

  const estimateLower = finiteOrNull(payload.estimate_lower ?? payload.total_estimate);
  const estimateUpper = finiteOrNull(payload.estimate_upper);
  if (estimateLower !== null && estimateLower < 0) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Estimate cannot be negative.');
  }
  if (estimateUpper !== null && estimateLower !== null && estimateUpper < estimateLower) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'estimate_upper cannot be lower than estimate_lower.');
  }

  return {
    assessmentRunId,
    missionId,
    missionUuid: missionUuid ? String(missionUuid).trim() : null,
    client: {
      name,
      email,
      phone: payload.phone ? String(payload.phone).trim() : null,
    },
    aircraft: normalizeAircraft(payload.aircraft ?? payload.aircraft_class ?? 'UNSPECIFIED'),
    passengerCount,
    manifest,
    legs,
    departureAt: legs[0] ? new Date(legs[0].departure_timestamptz) : null,
    departureAirport: legs[0]?.from || null,
    destinationAirport: legs.at(-1)?.to || null,
    estimateLower,
    estimateUpper,
    settlementRail,
    stablecoin,
    nonRefundableFeeAcknowledged: feeAcknowledged,
    permitResponsibilityAcknowledged,
    originalPayload: payload,
  };
}

function extractLegs(payload) {
  if (Array.isArray(payload.legs) && payload.legs.length >= 1) {
    if (payload.legs.length > 12) {
      throw fail('INVALID_MISSION_PAYLOAD', 400, 'legs must contain between 1 and 12 route legs.');
    }
    return payload.legs.map(normalizeLeg);
  }

  const from = cleanCode(payload.origin ?? payload.departure_airport ?? payload.from);
  const to = cleanCode(payload.destination ?? payload.arrival_airport ?? payload.to);
  const departure = payload.departure_timestamptz ?? payload.etd ?? payload.departureAt;
  if (from && to && departure) {
    return [normalizeLeg({ from, to, departure_timestamptz: departure }, 0)];
  }

  throw fail('INVALID_MISSION_PAYLOAD', 400, 'legs must contain between 1 and 12 route legs.');
}

function normalizeLeg(leg, index) {
  if (!isPlainObject(leg)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, `Leg ${index + 1} must be an object.`);
  }

  const from = cleanCode(leg.from ?? leg.fromFull ?? leg.origin);
  const to = cleanCode(leg.to ?? leg.toFull ?? leg.destination);
  const departure = leg.departure_timestamptz ?? leg.departureAt ?? leg.etd;
  if (!/^[A-Z0-9]{3,5}$/.test(from) || !/^[A-Z0-9]{3,5}$/.test(to) || !departure || !OFFSET_ISO_RE.test(String(departure))) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, `Leg ${index + 1} requires valid airport codes and an ISO departure timestamp with timezone.`);
  }

  const departureDate = new Date(departure);
  if (!Number.isFinite(departureDate.getTime())) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, `Leg ${index + 1} departure time is invalid.`);
  }

  const returnValue = leg.return_timestamptz ?? null;
  if (returnValue && (!OFFSET_ISO_RE.test(String(returnValue)) || !Number.isFinite(new Date(returnValue).getTime()))) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, `Leg ${index + 1} return timestamp is invalid.`);
  }

  return {
    ...leg,
    from,
    to,
    cost: finiteOrNull(leg.cost),
    distanceKm: finiteOrNull(leg.distanceKm),
    techStops: Number.isFinite(Number(leg.techStops)) ? Math.max(0, Math.trunc(Number(leg.techStops))) : 0,
    departure_timestamptz: departureDate.toISOString(),
    return_timestamptz: returnValue ? new Date(returnValue).toISOString() : null,
    fromFull: leg.fromFull ?? from,
    toFull: leg.toFull ?? to,
  };
}

function normalizeAircraft(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim().toUpperCase() || 'UNSPECIFIED';
    return { class: trimmed, raw: value };
  }
  if (!isPlainObject(value)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'aircraft must be a class string or an object.');
  }
  const aircraftClass = value.class ?? value.aircraft_class ?? value.size ?? value.type ?? value.category ?? value.model ?? 'UNSPECIFIED';
  return { ...value, class: String(aircraftClass).trim().toUpperCase() };
}

function getPassengerCount(payload, manifest) {
  const candidates = [
    manifest.passengers_count,
    manifest.passenger_count,
    manifest.totalPax,
    manifest.total_pax,
    manifest.pax,
    payload.passengers,
    payload.pax,
    payload.passenger_count,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  if (Array.isArray(manifest.passengers)) return manifest.passengers.length;
  const adults = Number(manifest.adults ?? 1);
  const children = Number(manifest.children ?? 0);
  const infants = Number(manifest.infants ?? 0);
  return adults + children + infants;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanCode(value) {
  return value == null ? '' : String(value).trim().toUpperCase();
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fail(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
