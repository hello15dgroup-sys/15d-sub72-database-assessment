const AIRPORT_SELECT = [
  'id', 'ident', 'icao_code', 'iata_code', 'gps_code', 'local_code', 'name', 'type',
  'latitude_deg', 'longitude_deg', 'elevation_ft', 'iso_country', 'iso_region',
  'country_name', 'region_name', 'last_updated',
].join(',');

const RUNWAY_SELECT = [
  'id', 'matched_airport_id', 'airport_match_status', 'length_ft', 'width_ft',
  'surface', 'closed', 'lighted', 'le_ident', 'he_ident',
].join(',');

const NAVAID_SELECT = [
  'id', 'associated_airport_id', 'airport_association_match_status', 'ident', 'name', 'type',
].join(',');

const AIRCRAFT_SELECT = [
  'Category', 'Type', 'Manufacturer', 'Model', 'Max_Passengers', 'Range_NM', 'Cruise_Speed_KTAS',
  'category', 'type', 'capacity', 'range_nm',
].join(',');

const FLEET_SELECT = [
  'tail_number', 'model', 'category', 'home_hub_icao', 'pax_capacity', 'max_range_nm',
  'readiness_status', 'is_verified_aoc', 'aoc_number', 'updated_at',
].join(',');

const SOURCE_SELECT = [
  'source_code', 'source_name', 'source_type', 'source_url', 'authority_level',
  'data_license', 'notes', 'active', 'updated_at',
].join(',');

const ACCEPTED_RUNWAY_MATCHES = new Set(['MATCHED_SOURCE_ID', 'MATCHED_COORDINATES']);
const ACCEPTED_AIRPORT_TYPES = new Set(['large_airport', 'medium_airport', 'small_airport']);

export const PERMIT_POLICY_NOTICE =
  'International or cross-border flight permits follow standard aviation lead times (typically 72+ hours). ' +
  'Obtaining permits—whether through standard channels or any arrangement the client/operator organizes—is ' +
  'strictly the responsibility of the client and the operator, not 15D Wings.';

export async function assessFromDatabase(env, mission) {
  const db = createDatabaseClient(env);
  const codes = [...new Set(mission.legs.flatMap(leg => [leg.from, leg.to]))];

  const [airportRows, aircraftRows, fleetRows, sourceRows] = await Promise.all([
    queryAirports(db, codes),
    db.select('aircrafts', { select: AIRCRAFT_SELECT, limit: '250' }),
    db.select('fleet_aircraft', { select: FLEET_SELECT, limit: '250' }),
    db.select('aviation_data_sources', { select: SOURCE_SELECT, active: 'eq.true', limit: '100' }),
  ]);

  const airportMatches = codes.map(code => ({ code, airport: resolveAirport(code, airportRows) }));
  const resolvedAirports = airportMatches.filter(item => item.airport).map(item => item.airport);
  const airportIds = [...new Set(resolvedAirports.map(a => String(a.id)))];
  const regionCodes = [...new Set(resolvedAirports.map(a => a.iso_region).filter(Boolean))];

  const [runwayRows, navaidRows, regionRows] = await Promise.all([
    airportIds.length
      ? db.select('runways', {
          select: RUNWAY_SELECT,
          matched_airport_id: `in.(${airportIds.join(',')})`,
          airport_match_status: 'in.(MATCHED_SOURCE_ID,MATCHED_COORDINATES)',
          limit: '1000',
        })
      : Promise.resolve([]),
    airportIds.length
      ? db.select('navaids', {
          select: NAVAID_SELECT,
          associated_airport_id: `in.(${airportIds.join(',')})`,
          airport_association_match_status: 'eq.MATCHED_IDENTIFIER',
          limit: '1000',
        })
      : Promise.resolve([]),
    regionCodes.length
      ? db.select('region', {
          select: 'id,code,name,continent,iso_country',
          code: `in.(${regionCodes.join(',')})`,
          limit: '1000',
        })
      : Promise.resolve([]),
  ]);

  const snapshot = {
    airports: airportRows,
    runways: runwayRows,
    navaids: navaidRows,
    regions: regionRows,
    aircrafts: aircraftRows,
    fleet_aircraft: fleetRows,
    source_registry: sourceRows,
  };

  return evaluateDatabaseSnapshot({ mission, snapshot, retrievedAt: new Date().toISOString() });
}

export function evaluateDatabaseSnapshot({ mission, snapshot, retrievedAt = new Date().toISOString() }) {
  const airportRows = Array.isArray(snapshot.airports) ? snapshot.airports : [];
  const runwayRows = Array.isArray(snapshot.runways) ? snapshot.runways : [];
  const navaidRows = Array.isArray(snapshot.navaids) ? snapshot.navaids : [];
  const regionRows = Array.isArray(snapshot.regions) ? snapshot.regions : [];
  const aircraftRows = Array.isArray(snapshot.aircrafts) ? snapshot.aircrafts : [];
  const fleetRows = Array.isArray(snapshot.fleet_aircraft) ? snapshot.fleet_aircraft : [];
  const sourceRows = Array.isArray(snapshot.source_registry) ? snapshot.source_registry : [];

  const blockers = [];
  const reasonCodes = [];
  const advisories = [];

  const addBlocker = (code, message, context = {}) => {
    reasonCodes.push(code);
    blockers.push({ code, message, ...context });
  };

  const addAdvisory = (code, message, context = {}) => {
    advisories.push({ code, message, ...context });
  };

  const regionByCode = new Map(regionRows.map(row => [String(row.code || '').toUpperCase(), row]));
  const resolved = new Map();
  const routeLegs = [];

  for (let i = 0; i < mission.legs.length; i += 1) {
    const leg = mission.legs[i];
    const origin = resolveAirport(leg.from, airportRows);
    const destination = resolveAirport(leg.to, airportRows);

    if (!origin) addBlocker('ORIGIN_AIRPORT_NOT_FOUND', `Origin airport ${leg.from} was not uniquely resolved in the airports table.`, { leg: i + 1, code: leg.from });
    if (!destination) addBlocker('DESTINATION_AIRPORT_NOT_FOUND', `Destination airport ${leg.to} was not uniquely resolved in the airports table.`, { leg: i + 1, code: leg.to });
    if (!origin || !destination) {
      routeLegs.push({ sequence: i + 1, from: leg.from, to: leg.to, resolved: false });
      continue;
    }

    resolved.set(String(origin.id), origin);
    resolved.set(String(destination.id), destination);

    validateAirport(origin, 'ORIGIN', i + 1, runwayRows, regionByCode, addBlocker);
    validateAirport(destination, 'DESTINATION', i + 1, runwayRows, regionByCode, addBlocker);

    const distanceNm = haversineNm(
      Number(origin.latitude_deg), Number(origin.longitude_deg),
      Number(destination.latitude_deg), Number(destination.longitude_deg),
    );

    if (!Number.isFinite(distanceNm) || distanceNm <= 0) {
      addBlocker('AIRPORT_COORDINATES_INVALID', `The database coordinates for ${leg.from} or ${leg.to} are invalid.`, { leg: i + 1 });
    }

    routeLegs.push({
      sequence: i + 1,
      resolved: true,
      from: leg.from,
      to: leg.to,
      origin: airportSummary(origin, runwayRows, navaidRows, regionByCode),
      destination: airportSummary(destination, runwayRows, navaidRows, regionByCode),
      database_great_circle_distance_nm: round(distanceNm, 1),
      client_distance_ignored: true,
      client_declared_technical_stops: leg.techStops || 0,
    });
  }

  for (let i = 1; i < mission.legs.length; i += 1) {
    const previous = resolveAirport(mission.legs[i - 1].to, airportRows);
    const current = resolveAirport(mission.legs[i].from, airportRows);
    if (previous && current && String(previous.id) !== String(current.id)) {
      addBlocker('ROUTE_CHAIN_DISCONTINUITY', `Leg ${i + 1} does not depart from the airport where leg ${i} arrives.`, { previous_to: mission.legs[i - 1].to, next_from: mission.legs[i].from });
    }
  }

  const resolvedAirportList = [...resolved.values()];
  const hasUnresolvedAirport = routeLegs.some(leg => leg.resolved === false);
  const hasMissingCountry = resolvedAirportList.some(airport => !String(airport.iso_country || '').trim());
  const countries = [...new Set(resolvedAirportList.map(a => String(a.iso_country || '').toUpperCase()).filter(Boolean))];
  const routeClassification = hasUnresolvedAirport || hasMissingCountry || countries.length === 0
    ? 'UNKNOWN'
    : countries.length === 1 ? 'DOMESTIC' : 'INTERNATIONAL_OR_MIXED';

  if (hasMissingCountry || countries.length === 0) {
    addBlocker('AIRPORT_COUNTRY_DATA_MISSING', 'One or more resolved airports do not have a country code in the database.');
  }

  if (routeClassification === 'INTERNATIONAL_OR_MIXED' || routeClassification === 'UNKNOWN') {
    addAdvisory('PERMIT_LEAD_TIME_AND_RESPONSIBILITY', PERMIT_POLICY_NOTICE, {
      route_classification: routeClassification,
      sovereign_countries: countries,
      standard_permit_window_hours: 72,
      permit_owner: 'CLIENT_AND_OPERATOR',
    });
  }

  const aircraftEvaluation = evaluateAircraft({ mission, aircraftRows, fleetRows, routeLegs, addBlocker });

  const uniqueReasonCodes = [...new Set(reasonCodes)];
  const decision = uniqueReasonCodes.length === 0 ? 'GO' : 'NO_GO';
  const uniqueAirportRows = [...resolved.values()];

  const evidence = {
    decision_engine: 'DATABASE_ONLY',
    retrieved_at: retrievedAt,
    permit_policy_notice: PERMIT_POLICY_NOTICE,
    source_tables: [
      'airports', 'runways', 'navaids', 'region', 'aircrafts', 'fleet_aircraft', 'aviation_data_sources',
    ],
    record_counts: {
      airports_returned: airportRows.length,
      airports_resolved: uniqueAirportRows.length,
      runways_returned: runwayRows.length,
      navaids_returned: navaidRows.length,
      regions_returned: regionRows.length,
      aircraft_catalogue_records: aircraftRows.length,
      fleet_records: fleetRows.length,
      source_registry_records: sourceRows.length,
    },
    source_registry: sourceRows.map(row => ({
      source_code: row.source_code,
      source_name: row.source_name,
      source_type: row.source_type,
      source_url: row.source_url,
      authority_level: row.authority_level,
      data_license: row.data_license,
      active: row.active,
      updated_at: row.updated_at || null,
      notes: row.notes || null,
    })),
    airport_records: uniqueAirportRows.map(airport => ({
      ...airportSummary(airport, runwayRows, navaidRows, regionByCode),
      source_last_updated: airport.last_updated || null,
    })),
    runway_records: runwayRows.map(runway => ({
      id: runway.id,
      matched_airport_id: runway.matched_airport_id,
      match_status: runway.airport_match_status,
      length_ft: runway.length_ft,
      width_ft: runway.width_ft,
      surface: runway.surface,
      closed: runway.closed,
      lighted: runway.lighted,
    })),
    navaid_records: navaidRows.map(navaid => ({
      id: navaid.id,
      airport_id: navaid.associated_airport_id,
      ident: navaid.ident,
      name: navaid.name,
      type: navaid.type,
    })),
    limitations: [
      PERMIT_POLICY_NOTICE,
      'The database contains reference data, not live NOTAM, weather, slot, curfew, or operator-confirmed availability feeds.',
      'Runway length and width are not an aircraft-specific take-off or landing performance calculation.',
      'Aircraft catalogue range is a published reference value and does not account for payload, reserves, weather, routing, alternates, or operational restrictions.',
      'Navaid presence is descriptive only; it does not prove serviceability, approach availability, aircraft equipment, or crew qualification.',
      'A GO is a database eligibility result only. It is not a permit approval, operator acceptance, aircraft reservation, dispatch release, or guarantee of flight execution.',
    ],
  };

  const routeSnapshot = {
    route_classification: routeClassification,
    sovereign_countries: countries,
    airport_resolution_complete: routeLegs.length === mission.legs.length && routeLegs.every(leg => leg.resolved === true),
    permit_assessment_performed: false,
    permit_responsibility: 'CLIENT_AND_OPERATOR',
    legs: routeLegs,
  };

  return {
    decision,
    reason_codes: uniqueReasonCodes,
    blockers,
    advisories,
    route_snapshot: routeSnapshot,
    aircraft_evaluation: aircraftEvaluation,
    evidence,
  };
}

function validateAirport(airport, role, legNumber, runways, regionByCode, addBlocker) {
  const airportType = String(airport.type || '').toLowerCase();
  if (!ACCEPTED_AIRPORT_TYPES.has(airportType)) {
    addBlocker('AIRPORT_TYPE_NOT_SUPPORTED', `${airport.icao_code || airport.ident} is classified as ${airport.type || 'unknown'}; the database gate accepts fixed-wing airport categories only.`, { airport: airport.icao_code || airport.ident, role, leg: legNumber });
  }

  if (!airport.iso_country) {
    addBlocker('AIRPORT_COUNTRY_DATA_MISSING', `${airport.icao_code || airport.ident} has no ISO country code.`, { airport: airport.icao_code || airport.ident, role, leg: legNumber });
  }

  const region = airport.iso_region ? regionByCode.get(String(airport.iso_region).toUpperCase()) : null;
  if (!region) {
    addBlocker('AIRPORT_REGION_NOT_FOUND', `${airport.icao_code || airport.ident} has no matching region record.`, { airport: airport.icao_code || airport.ident, iso_region: airport.iso_region || null, role, leg: legNumber });
  } else if (region.iso_country && airport.iso_country && String(region.iso_country).toUpperCase() !== String(airport.iso_country).toUpperCase()) {
    addBlocker('AIRPORT_REGION_COUNTRY_MISMATCH', `${airport.icao_code || airport.ident} region record belongs to a different country than the airport record.`, { airport: airport.icao_code || airport.ident, iso_region: airport.iso_region, airport_country: airport.iso_country, region_country: region.iso_country, role, leg: legNumber });
  }

  const linked = runways.filter(row => String(row.matched_airport_id) === String(airport.id) && ACCEPTED_RUNWAY_MATCHES.has(row.airport_match_status));
  const usable = linked.filter(row => row.closed === false && Number(row.length_ft) > 0 && Number(row.width_ft) > 0 && String(row.surface || '').trim().length > 0);
  if (usable.length === 0) {
    addBlocker('NO_DATABASE_OPEN_RUNWAY', `${airport.icao_code || airport.ident} has no positively matched runway record with closed=false and populated positive dimensions and surface.`, { airport: airport.icao_code || airport.ident, matched_runways: linked.length, role, leg: legNumber });
  }
}

function evaluateAircraft({ mission, aircraftRows, fleetRows, routeLegs, addBlocker }) {
  const requestedModel = mission.aircraft?.model || mission.aircraft?.aircraft_model || null;
  const requestedClass = mission.aircraft?.class || 'UNSPECIFIED';
  let classRows;

  if (requestedModel) {
    const needle = normalizeToken(requestedModel);
    classRows = aircraftRows.filter(row => normalizeToken(row.Model || row.model) === needle);
  } else {
    classRows = aircraftRows.filter(row => matchesAircraftClass(requestedClass, row.Type || row.type, row.Category || row.category));
    if (classRows.length === 0) {
      const needle = normalizeToken(requestedClass);
      classRows = aircraftRows.filter(row => normalizeToken(row.Model || row.model) === needle);
    }
  }

  if (classRows.length === 0) {
    addBlocker('AIRCRAFT_CLASS_NOT_IN_CATALOGUE', `No aircraft catalogue record matches the requested aircraft class/model: ${requestedModel || requestedClass}.`);
    return {
      requested_class: requestedClass,
      requested_model: requestedModel,
      catalogue_matches: 0,
      capacity_matches: [],
      eligible_models: [],
      fleet_records: [],
    };
  }

  const capacityMatches = classRows.filter(row => numeric(row.Max_Passengers ?? row.capacity) >= mission.passengerCount);
  if (capacityMatches.length === 0) {
    addBlocker('AIRCRAFT_CAPACITY_EXCEEDED', `No matching catalogue aircraft has capacity for ${mission.passengerCount} passengers.`);
  }

  const maxLegDistance = Math.max(0, ...routeLegs.map(leg => Number(leg.database_great_circle_distance_nm) || 0));
  const rangeMatches = capacityMatches.filter(row => numeric(row.Range_NM ?? row.range_nm) >= maxLegDistance);
  if (capacityMatches.length > 0 && rangeMatches.length === 0) {
    addBlocker('AIRCRAFT_RANGE_EXCEEDED', `No matching catalogue aircraft has published range sufficient for the longest database-calculated leg (${round(maxLegDistance, 1)} NM).`);
  }

  const eligibleModels = rangeMatches
    .map(row => ({
      category: row.Category || row.category || null,
      type: row.Type || row.type || null,
      manufacturer: row.Manufacturer || null,
      model: row.Model || row.model || null,
      max_passengers: numeric(row.Max_Passengers ?? row.capacity),
      range_nm: numeric(row.Range_NM ?? row.range_nm),
      cruise_speed_ktas: numeric(row.Cruise_Speed_KTAS),
    }))
    .sort((a, b) => a.range_nm - b.range_nm || a.max_passengers - b.max_passengers);

  const fleetRecords = fleetRows
    .filter(row => matchesAircraftClass(requestedClass, row.category, row.category))
    .map(row => ({
      tail_number: row.tail_number,
      model: row.model,
      category: row.category,
      home_hub_icao: row.home_hub_icao,
      pax_capacity: numeric(row.pax_capacity),
      max_range_nm: numeric(row.max_range_nm),
      readiness_status: row.readiness_status,
      is_verified_aoc: row.is_verified_aoc === true,
      updated_at: row.updated_at || null,
    }));

  return {
    requested_class: requestedClass,
    requested_model: requestedModel,
    catalogue_matches: classRows.length,
    capacity_matches: capacityMatches.map(row => row.Model || row.model).filter(Boolean),
    maximum_database_leg_distance_nm: round(maxLegDistance, 1),
    eligible_models: eligibleModels,
    fleet_records: fleetRecords,
    fleet_records_are_informational_only: true,
  };
}

function matchesAircraftClass(requested, type, category) {
  const token = normalizeToken(requested);
  const typeToken = normalizeToken(type);
  const categoryToken = normalizeToken(category);

  if (!token || token === 'UNSPECIFIED') return false;
  if (typeToken === token || categoryToken === token) return true;

  const rules = [
    { keys: ['LIGHT', 'LIGHTJET'], test: () => typeToken.includes('LIGHTJET') && !typeToken.includes('VERY') },
    { keys: ['MID', 'MIDSIZE', 'MIDSIZEJET'], test: () => typeToken.includes('MIDSIZEJET') },
    { keys: ['SUPERMID', 'SUPERMIDSIZE', 'SUPERMIDSIZEJET'], test: () => typeToken.includes('SUPERMIDSIZE') },
    { keys: ['HEAVY', 'HEAVYJET', 'LARGEHEAVYJET'], test: () => typeToken.includes('HEAVY') },
    { keys: ['ULTRA', 'ULTRALONGRANGE', 'ULTRALONGRANGEJET'], test: () => typeToken.includes('ULTRALONGRANGE') },
    { keys: ['VLJ', 'VERY LIGHT JET', 'VERY LIGHT JET VLJ'], test: () => typeToken.includes('VERY LIGHT JET'.replaceAll(' ', '')) || typeToken.includes('VLJ') },
    { keys: ['TURBOPROP'], test: () => typeToken.includes('TURBOPROP') },
    { keys: ['REGIONAL', 'REGIONALJET'], test: () => typeToken.includes('REGIONALJET') },
    { keys: ['NARROWBODY', 'NARROWBODYAIRLINER'], test: () => typeToken.includes('NARROWBODY') },
    { keys: ['WIDEBODY', 'WIDEBODYAIRLINER'], test: () => typeToken.includes('WIDEBODY') },
    { keys: ['VIPAIRLINER'], test: () => typeToken.includes('VIPAIRLINER') },
  ];

  const rule = rules.find(item => item.keys.includes(token));
  return rule ? rule.test() : typeToken.includes(token) || categoryToken.includes(token);
}

function resolveAirport(code, rows) {
  const normalized = String(code || '').toUpperCase();
  const priority = normalized.length === 3
    ? ['iata_code', 'ident', 'gps_code', 'icao_code', 'local_code']
    : ['icao_code', 'ident', 'gps_code', 'iata_code', 'local_code'];
  for (const field of priority) {
    const matches = rows.filter(row => String(row[field] || '').toUpperCase() === normalized);
    const unique = [...new Map(matches.map(row => [String(row.id), row])).values()];
    if (unique.length === 1) return unique[0];
    if (unique.length > 1) return null;
  }
  return null;
}

function airportSummary(airport, runways, navaids, regionByCode) {
  const linkedRunways = runways.filter(row => String(row.matched_airport_id) === String(airport.id) && ACCEPTED_RUNWAY_MATCHES.has(row.airport_match_status));
  const usableRunways = linkedRunways.filter(row => row.closed === false && Number(row.length_ft) > 0 && Number(row.width_ft) > 0 && String(row.surface || '').trim());
  const linkedNavaids = navaids.filter(row => String(row.associated_airport_id) === String(airport.id));
  const region = airport.iso_region ? regionByCode.get(String(airport.iso_region).toUpperCase()) : null;
  return {
    id: airport.id,
    code: airport.icao_code || airport.ident,
    icao_code: airport.icao_code || null,
    iata_code: airport.iata_code || null,
    name: airport.name,
    type: airport.type,
    country: airport.country_name || null,
    iso_country: airport.iso_country || null,
    region: region?.name || airport.region_name || null,
    iso_region: airport.iso_region || null,
    latitude_deg: numeric(airport.latitude_deg),
    longitude_deg: numeric(airport.longitude_deg),
    elevation_ft: numeric(airport.elevation_ft),
    runway_records: linkedRunways.length,
    database_open_runways: usableRunways.length,
    longest_database_open_runway_ft: usableRunways.reduce((max, row) => Math.max(max, numeric(row.length_ft)), 0),
    matched_navaids: linkedNavaids.length,
  };
}

function haversineNm(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return NaN;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function createDatabaseClient(env) {
  const baseUrl = String(env.SUPABASE_URL || 'https://mhplukffgcxiorpfunyy.supabase.co').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw fail('SUPABASE_CONFIG_MISSING', 503, 'SUPABASE_SERVICE_ROLE_KEY is required.');

  return {
    async select(table, filters) {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(filters)) params.set(name, String(value));
      const url = `${baseUrl}/rest/v1/${table}?${params.toString()}`;
      let response;
      try {
        response = await fetch(url, {
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw fail('DATABASE_QUERY_FAILED', 502, `${table} query failed: ${error.message}`);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw fail('DATABASE_QUERY_FAILED', 502, `${table} query returned HTTP ${response.status}: ${body.slice(0, 700)}`);
      }
      const data = await response.json().catch(() => null);
      if (!Array.isArray(data)) throw fail('DATABASE_QUERY_FAILED', 502, `${table} query did not return a JSON array.`);
      return data;
    },
  };
}

async function queryAirports(db, codes) {
  const list = codes.join(',');
  const orFilter = `(${[
    `icao_code.in.(${list})`,
    `ident.in.(${list})`,
    `gps_code.in.(${list})`,
    `iata_code.in.(${list})`,
    `local_code.in.(${list})`,
  ].join(',')})`;
  return db.select('airports', { select: AIRPORT_SELECT, or: orFilter, limit: '1000' });
}

function normalizeToken(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function numeric(value) {
  const number = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number;
}

function round(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function fail(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
