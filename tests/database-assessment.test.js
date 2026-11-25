import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDatabaseSnapshot } from '../modules/database-assessment.js';

const mission = (aircraftClass = 'HEAVY', pax = 4) => ({
  missionId: '15D-TEST1',
  passengerCount: pax,
  aircraft: { class: aircraftClass },
  legs: [{ from: 'DNAA', to: 'DNMM', techStops: 0 }],
});

const baseSnapshot = () => ({
  airports: [
    { id: 1, ident: 'DNAA', icao_code: 'DNAA', iata_code: 'ABV', name: 'Abuja', type: 'large_airport', latitude_deg: 9.00679, longitude_deg: 7.26317, iso_country: 'NG', iso_region: 'NG-FC', country_name: 'Nigeria', region_name: 'Federal Capital Territory', last_updated: '2025-01-01T00:00:00Z' },
    { id: 2, ident: 'DNMM', icao_code: 'DNMM', iata_code: 'LOS', name: 'Lagos', type: 'large_airport', latitude_deg: 6.57737, longitude_deg: 3.32116, iso_country: 'NG', iso_region: 'NG-LA', country_name: 'Nigeria', region_name: 'Lagos State', last_updated: '2025-01-01T00:00:00Z' },
  ],
  runways: [
    { id: 11, matched_airport_id: 1, airport_match_status: 'MATCHED_SOURCE_ID', length_ft: 11800, width_ft: 150, surface: 'ASP', closed: false },
    { id: 12, matched_airport_id: 2, airport_match_status: 'MATCHED_SOURCE_ID', length_ft: 12794, width_ft: 148, surface: 'ASP', closed: false },
  ],
  navaids: [],
  regions: [
    { id: 101, code: 'NG-FC', name: 'Federal Capital Territory', iso_country: 'NG' },
    { id: 102, code: 'NG-LA', name: 'Lagos State', iso_country: 'NG' },
  ],
  aircrafts: [
    { Category: 'Private Jet', Type: 'Large / Heavy Jet', Manufacturer: 'Example', Model: 'Heavy 5000', Max_Passengers: 8, Range_NM: 5000, Cruise_Speed_KTAS: 450 },
  ],
  fleet_aircraft: [],
});

test('GO when domestic airports, matched open runways, regions and aircraft capacity/range all match', () => {
  const result = evaluateDatabaseSnapshot({ mission: mission(), snapshot: baseSnapshot() });
  assert.equal(result.decision, 'GO');
  assert.deepEqual(result.reason_codes, []);
  assert.equal(result.route_snapshot.route_classification, 'DOMESTIC');
  assert.equal(result.aircraft_evaluation.eligible_models[0].model, 'Heavy 5000');
});

test('NO_GO when route is international under the existing 72-hour corridor lock', () => {
  const snapshot = baseSnapshot();
  snapshot.airports[1] = {
    ...snapshot.airports[1],
    iso_country: 'GH',
    iso_region: 'GH-AA',
    country_name: 'Ghana',
  };
  snapshot.regions.push({ id: 103, code: 'GH-AA', name: 'Greater Accra', iso_country: 'GH' });
  const result = evaluateDatabaseSnapshot({ mission: mission(), snapshot });
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.reason_codes.includes('SUB72_INTERNATIONAL_CORRIDOR_LOCK'));
});

test('NO_GO when no positively matched open runway exists', () => {
  const snapshot = baseSnapshot();
  snapshot.runways[0].closed = true;
  const result = evaluateDatabaseSnapshot({ mission: mission(), snapshot });
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.reason_codes.includes('NO_DATABASE_OPEN_RUNWAY'));
});

test('NO_GO when aircraft capacity is insufficient', () => {
  const result = evaluateDatabaseSnapshot({ mission: mission('HEAVY', 10), snapshot: baseSnapshot() });
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.reason_codes.includes('AIRCRAFT_CAPACITY_EXCEEDED'));
});

test('NO_GO when aircraft catalogue range is insufficient', () => {
  const snapshot = baseSnapshot();
  snapshot.aircrafts[0].Range_NM = 50;
  const result = evaluateDatabaseSnapshot({ mission: mission(), snapshot });
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.reason_codes.includes('AIRCRAFT_RANGE_EXCEEDED'));
});

test('Navaid absence is informational and does not by itself block a database GO', () => {
  const result = evaluateDatabaseSnapshot({ mission: mission(), snapshot: baseSnapshot() });
  assert.equal(result.decision, 'GO');
  assert.equal(result.evidence.record_counts.navaids_returned, 0);
});
