const MISSION_ID_RE = /^15D-[A-Z0-9]{5}$/;
const OFFSET_ISO_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function normalizeMissionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Request body must be a JSON object.');
  }

  for (const key of ['name', 'email', 'request_id', 'ref_id', 'aircraft', 'legs', 'manifest']) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
      throw fail('INVALID_MISSION_PAYLOAD', 400, `Missing required field: ${key}`);
    }
  }

  const missionId = String(payload.request_id).trim().toUpperCase();
  const refId = String(payload.ref_id).trim().toUpperCase();
  if (!MISSION_ID_RE.test(missionId) || refId !== missionId) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'request_id and ref_id must be the same canonical 15D-ABCDE mission identifier.');
  }

  const name = String(payload.name).trim();
  const email = String(payload.email).trim().toLowerCase();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'A client name and valid email are required.');
  }

  if (!Array.isArray(payload.legs) || payload.legs.length < 1 || payload.legs.length > 12) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'legs must contain between 1 and 12 route legs.');
  }

  const legs = payload.legs.map(normalizeLeg);
  const departureAt = new Date(legs[0].departure_timestamptz);

  const estimateLower = finiteOrNull(payload.estimate_lower ?? payload.total_estimate);
  const estimateUpper = finiteOrNull(payload.estimate_upper);
  if (estimateLower !== null && estimateLower < 0) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Estimate cannot be negative.');
  }
  if (estimateUpper !== null && estimateLower !== null && estimateUpper < estimateLower) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'estimate_upper cannot be lower than estimate_lower.');
  }

  const aircraft = normalizeAircraft(payload.aircraft);
  const manifest = payload.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'manifest must be an object.');
  }

  const passengerCount = getPassengerCount(payload, manifest);
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 525) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Passenger count must be between 1 and 525.');
  }

  return {
    missionId,
    client: {
      name,
      email,
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

function normalizeLeg(leg, index) {
  if (!leg || typeof leg !== 'object' || Array.isArray(leg)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, `Leg ${index + 1} must be an object.`);
  }

  const from = cleanCode(leg.from ?? leg.fromFull);
  const to = cleanCode(leg.to ?? leg.toFull);
  const departure = leg.departure_timestamptz ?? leg.departureAt;
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
    distanceKm: finiteOrNull(leg.distanceKm), // retained for the frontend contract; never used as the authoritative distance.
    techStops: Number.isFinite(Number(leg.techStops)) ? Math.max(0, Math.trunc(Number(leg.techStops))) : 0,
    departure_timestamptz: departureDate.toISOString(),
    return_timestamptz: returnValue ? new Date(returnValue).toISOString() : null,
    fromFull: leg.fromFull ?? from,
    toFull: leg.toFull ?? to,
  };
}

function normalizeAircraft(value) {
  if (typeof value === 'string') {
    return { class: value.trim().toUpperCase(), raw: value };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
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
