export function calculateUrgency(departureAt, submittedAt = new Date()) {
  const departureMs = new Date(departureAt).getTime();
  const submittedMs = new Date(submittedAt).getTime();
  if (!Number.isFinite(departureMs) || !Number.isFinite(submittedMs)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Invalid departure or submission time.');
  }

  const hoursToDeparture = (departureMs - submittedMs) / 3_600_000;
  if (hoursToDeparture <= 0) {
    throw fail('INVALID_MISSION_PAYLOAD', 422, 'Departure time is in the past.');
  }
  if (hoursToDeparture >= 72) {
    throw fail('NOT_A_SUB72_MISSION', 422, 'This endpoint accepts departures strictly below 72 hours.');
  }

  return {
    hoursToDeparture: Number(hoursToDeparture.toFixed(4)),
    band: 'SUB72_FLAT',
    feeApplicable: true,
    departureAt: new Date(departureMs).toISOString(),
    calculatedAt: new Date(submittedMs).toISOString(),
  };
}

function fail(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
