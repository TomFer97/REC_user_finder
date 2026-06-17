const DEFAULT_MATCH_RADIUS_M = 120;

const GENERIC_NAMES = new Set([
  'yes',
  'building',
  'industrial',
  'commercial',
  'retail',
  'office',
  'warehouse',
  'supermarket',
  'bank',
  'hotel',
  'school',
  'hospital',
  'public',
  'civic',
  'government',
  'amenity',
  'shop',
  'tourism',
  'leisure'
]);

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function firstArrayValue(value) {
  if (Array.isArray(value)) return firstValue(...value);
  return firstValue(value);
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => {
    if (current === undefined || current === null) return undefined;
    return current[key];
  }, obj);
}

function valueFromPaths(obj, paths) {
  for (const path of paths) {
    const value = firstArrayValue(getNestedValue(obj, path));
    if (value) return value;
  }
  return '';
}

function isGenericName(value) {
  const normalized = normalizeText(value);
  if (!normalized) return true;
  if (GENERIC_NAMES.has(normalized)) return true;
  return normalized.length <= 2;
}

function usefulName(...values) {
  return values.find(value => value && !isGenericName(value)) || '';
}

function featurePoint(feature) {
  const geometry = feature && feature.geometry;
  if (geometry && geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
    const lon = Number(geometry.coordinates[0]);
    const lat = Number(geometry.coordinates[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  }

  const p = Object.assign({}, feature || {}, (feature && feature.properties) || {});
  const lon = Number(firstValue(p.lon, p.longitude));
  const lat = Number(firstValue(p.lat, p.latitude));
  if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  return null;
}

function distanceMeters(a, b) {
  const toRad = value => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

function tokenOverlapScore(a, b) {
  const left = normalizeText(a).split(' ').filter(Boolean);
  const right = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (!left.length || !right.size) return 0;
  const hits = left.filter(token => right.has(token)).length;
  return hits / Math.max(left.length, right.size);
}

function osmName(properties) {
  return usefulName(
    properties.name,
    properties.official_name,
    properties.operator,
    properties.brand,
    properties.short_name,
    properties.alt_name
  );
}

function genericOsmLabel(properties) {
  return firstValue(
    properties.name,
    properties.operator,
    properties.brand,
    properties.shop,
    properties.craft,
    properties.office,
    properties.amenity,
    properties.leisure,
    properties.tourism,
    properties.healthcare,
    properties.building,
    properties.landuse
  );
}

function baseCandidateFromOsm(feature) {
  const p = (feature && feature.properties) || {};
  return {
    provider: 'osm',
    label: 'OpenStreetMap',
    name: osmName(p),
    phone: firstValue(p['contact:phone'], p.phone),
    email: firstValue(p['contact:email'], p.email),
    website: firstValue(p['contact:website'], p.website, p.url),
    address: firstValue(p.address),
    confidence: p.confidence === 'alta' ? 0.75 : 0.55,
    distance_m: 0,
    raw_id: firstValue(p._osm_id)
  };
}

function normalizeCandidate(candidate, fallbackProvider) {
  if (!candidate) return null;
  const normalized = {
    provider: candidate.provider || fallbackProvider || 'unknown',
    label: candidate.label || candidate.provider || fallbackProvider || 'unknown',
    name: firstValue(candidate.name),
    phone: firstValue(candidate.phone),
    email: firstValue(candidate.email),
    website: firstValue(candidate.website),
    address: firstValue(candidate.address),
    category: firstValue(candidate.category),
    confidence: Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : 0.5,
    distance_m: Number.isFinite(Number(candidate.distance_m)) ? Number(candidate.distance_m) : null,
    raw_id: firstValue(candidate.raw_id, candidate.id)
  };

  if (!normalized.name && !normalized.phone && !normalized.email && !normalized.website) return null;
  return normalized;
}

function scoreCandidate(feature, candidate, options = {}) {
  const p = (feature && feature.properties) || {};
  const radius = options.radiusMeters || DEFAULT_MATCH_RADIUS_M;
  const osmUsefulName = osmName(p);
  const osmLabel = genericOsmLabel(p);
  const hasGenericLabel = !osmUsefulName || isGenericName(osmLabel);
  const distance = Number(candidate.distance_m);

  if (Number.isFinite(distance) && distance > radius) return -1;

  let score = 0;
  if (candidate.name) score += hasGenericLabel ? 3 : 1;
  if (candidate.phone) score += 2;
  if (candidate.email) score += 2;
  if (candidate.website) score += 1.5;
  if (candidate.category) score += 0.5;
  if (Number.isFinite(distance)) {
    score += Math.max(0, 2 - distance / Math.max(radius, 1) * 2);
  }

  const overlap = tokenOverlapScore(osmUsefulName || osmLabel, candidate.name);
  if (overlap) score += overlap * 3;
  if (osmUsefulName && candidate.name && !overlap && Number.isFinite(distance) && distance > 45) {
    score -= 2;
  }

  return score;
}

function pickBestCandidate(feature, candidates, options = {}) {
  return candidates
    .map(candidate => {
      const normalized = normalizeCandidate(candidate);
      if (!normalized) return null;
      return Object.assign(normalized, { _score: scoreCandidate(feature, normalized, options) });
    })
    .filter(candidate => candidate && candidate._score >= 1.5)
    .sort((a, b) => b._score - a._score)[0] || null;
}

function mergeEnrichment(feature, candidates = [], options = {}) {
  const properties = Object.assign({}, (feature && feature.properties) || {});
  const osmCandidate = baseCandidateFromOsm(feature);
  const externalBest = pickBestCandidate(feature, candidates, options);
  const externalName = externalBest && externalBest.name && !isGenericName(externalBest.name)
    ? externalBest.name
    : '';
  const name = osmCandidate.name || externalName;
  const phone = osmCandidate.phone || (externalBest && externalBest.phone) || '';
  const email = osmCandidate.email || (externalBest && externalBest.email) || '';
  const website = osmCandidate.website || (externalBest && externalBest.website) || '';
  const hasExternalContribution = Boolean(externalBest && (
    (!osmCandidate.name && externalName) ||
    (!osmCandidate.phone && externalBest.phone) ||
    (!osmCandidate.email && externalBest.email) ||
    (!osmCandidate.website && externalBest.website)
  ));
  const source = hasExternalContribution
    ? `${externalBest.label}${osmCandidate.name || osmCandidate.phone || osmCandidate.email || osmCandidate.website ? ' + OSM' : ''}`
    : (osmCandidate.name || osmCandidate.phone || osmCandidate.email || osmCandidate.website ? 'OpenStreetMap' : '');

  return Object.assign({}, feature, {
    properties: Object.assign(properties, {
      osm_display_name: genericOsmLabel(properties),
      enriched_name: name,
      enriched_phone: phone,
      enriched_email: email,
      enriched_website: website,
      enrichment_source: source,
      enrichment_confidence: hasExternalContribution
        ? Math.min(1, Math.max(externalBest.confidence || 0.5, 0.65)).toFixed(2)
        : (source ? String(osmCandidate.confidence) : ''),
      enrichment_distance_m: hasExternalContribution && Number.isFinite(externalBest.distance_m)
        ? Math.round(externalBest.distance_m)
        : '',
      enrichment_note: hasExternalContribution
        ? `Arricchito da ${externalBest.label}${externalBest.distance_m !== null ? ` entro ${Math.round(externalBest.distance_m)} m` : ''}.`
        : (source ? 'Contatti disponibili nei tag OSM.' : 'Nessun arricchimento automatico disponibile.')
    })
  });
}

function shouldAttemptRemoteEnrichment(feature, options = {}) {
  const p = (feature && feature.properties) || {};
  const area = Number(p.building_area_m2) || 0;
  const missingUsefulName = !osmName(p);
  const missingContacts = !firstValue(p['contact:phone'], p.phone, p['contact:email'], p.email, p['contact:website'], p.website, p.url);
  const publicLike = Boolean(
    p.amenity ||
    p.healthcare ||
    p.leisure ||
    p.public_transport ||
    p.railway ||
    ['school', 'hospital', 'public', 'civic', 'government'].includes(String(p.building || '').toLowerCase())
  );

  return missingUsefulName || (missingContacts && (publicLike || area >= (options.largeRoofThreshold || 750)));
}

function candidateFromOvertureFeature(placeFeature, targetFeature) {
  const p = (placeFeature && placeFeature.properties) || {};
  const point = featurePoint(placeFeature);
  const targetPoint = featurePoint(targetFeature);
  const distance = point && targetPoint ? distanceMeters(point, targetPoint) : null;
  const names = p.names || {};
  const brand = p.brand || {};
  const categories = p.categories || {};
  const addresses = Array.isArray(p.addresses) ? p.addresses : [];
  const address = addresses[0] || {};

  return normalizeCandidate({
    provider: 'overture',
    label: 'Overture Places',
    name: valueFromPaths(p, [
      'names.primary',
      'names.common.0',
      'names.common',
      'name'
    ]) || valueFromPaths(brand, ['names.primary', 'names.common.0']),
    phone: firstArrayValue(p.phones),
    email: firstArrayValue(p.emails),
    website: firstArrayValue(p.websites),
    address: firstValue(address.freeform, address.formatted),
    category: firstValue(categories.primary, categories.main, categories.basic_category, categories.basic),
    confidence: Number.isFinite(Number(p.confidence)) ? Number(p.confidence) : 0.7,
    distance_m: distance,
    raw_id: p.id || placeFeature.id
  }, 'overture');
}

function candidateFromDirectoryRecord(record, targetFeature, provider, label) {
  const point = featurePoint(record);
  const targetPoint = featurePoint(targetFeature);
  const distance = point && targetPoint ? distanceMeters(point, targetPoint) : null;
  const p = record.properties || record;

  return normalizeCandidate({
    provider,
    label,
    name: firstValue(p.name, p.nome, p.denominazione, p.description, p.ragione_sociale),
    phone: firstValue(p.phone, p.telefono, p.tel, p.numero_telefono),
    email: firstValue(p.email, p.mail, p.pec, p.mail1, p.email_pec),
    website: firstValue(p.website, p.sito, p.url, p.www),
    address: firstValue(p.address, p.indirizzo),
    category: firstValue(p.category, p.categoria, p.tipo),
    confidence: Number.isFinite(Number(p.confidence)) ? Number(p.confidence) : 0.75,
    distance_m: distance,
    raw_id: firstValue(p.id, p.codice, record.id)
  }, provider);
}

function matchLocalRecords(targetFeature, records, options = {}) {
  const radius = options.radiusMeters || DEFAULT_MATCH_RADIUS_M;
  return (records || [])
    .map(record => options.mapper(record, targetFeature))
    .filter(candidate => candidate && (!Number.isFinite(candidate.distance_m) || candidate.distance_m <= radius))
    .sort((a, b) => scoreCandidate(targetFeature, b, options) - scoreCandidate(targetFeature, a, options));
}

module.exports = {
  DEFAULT_MATCH_RADIUS_M,
  normalizeText,
  firstValue,
  featurePoint,
  distanceMeters,
  isGenericName,
  osmName,
  shouldAttemptRemoteEnrichment,
  mergeEnrichment,
  candidateFromOvertureFeature,
  candidateFromDirectoryRecord,
  matchLocalRecords,
  scoreCandidate
};
