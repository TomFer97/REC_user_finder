const assert = require('assert');

const {
  mergeEnrichment,
  candidateFromOvertureFeature,
  candidateFromDirectoryRecord,
  shouldAttemptRemoteEnrichment
} = require('../enrichment');

const genericFeature = {
  type: 'Feature',
  properties: {
    building: 'yes',
    building_area_m2: 1800,
    confidence: 'media'
  },
  geometry: { type: 'Point', coordinates: [9.526, 45.576] }
};

const overturePlace = {
  type: 'Feature',
  properties: {
    names: { primary: 'Palestra Comunale Vaprio' },
    phones: ['+39 02 123456'],
    websites: ['https://example.org/palestra'],
    categories: { primary: 'sports_centre' },
    confidence: 0.82
  },
  geometry: { type: 'Point', coordinates: [9.5263, 45.5761] }
};

const overtureCandidate = candidateFromOvertureFeature(overturePlace, genericFeature);
const enriched = mergeEnrichment(genericFeature, [overtureCandidate]);

assert.strictEqual(enriched.properties.enriched_name, 'Palestra Comunale Vaprio');
assert.strictEqual(enriched.properties.enriched_phone, '+39 02 123456');
assert.strictEqual(enriched.properties.enriched_website, 'https://example.org/palestra');
assert.ok(enriched.properties.enrichment_source.includes('Overture Places'));
assert.strictEqual(shouldAttemptRemoteEnrichment(genericFeature), true);

const osmNamedFeature = {
  type: 'Feature',
  properties: {
    name: 'Studio Rossi',
    phone: '+39 02 555',
    building_area_m2: 100
  },
  geometry: { type: 'Point', coordinates: [9.526, 45.576] }
};
const retained = mergeEnrichment(osmNamedFeature, [overtureCandidate]);

assert.strictEqual(retained.properties.enriched_name, 'Studio Rossi');
assert.strictEqual(retained.properties.enriched_phone, '+39 02 555');

const directoryCandidate = candidateFromDirectoryRecord({
  name: 'Biblioteca Civica',
  email: 'biblioteca@example.org',
  lat: 45.57605,
  lon: 9.52608
}, genericFeature, 'indicepa', 'IndicePA locale');
const directoryEnriched = mergeEnrichment(genericFeature, [directoryCandidate]);

assert.strictEqual(directoryEnriched.properties.enriched_name, 'Biblioteca Civica');
assert.strictEqual(directoryEnriched.properties.enriched_email, 'biblioteca@example.org');
assert.ok(directoryEnriched.properties.enrichment_source.includes('IndicePA locale'));

console.log('enrichment tests passed');
