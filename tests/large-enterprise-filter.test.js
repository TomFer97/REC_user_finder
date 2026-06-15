const assert = require('assert');
const fs = require('fs');
const path = require('path');

const filter = require('../webapp/large-enterprise-filter.js');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../webapp/data/excluded-entities.json'), 'utf8'));

assert.strictEqual(filter.findRule({ name: 'Carrefour Market' }, config).label, 'Carrefour');
assert.strictEqual(filter.findRule({ brand: 'Amplifon' }, config).label, 'Amplifon');
assert.strictEqual(filter.findRule({ brand: 'MD' }, config).label, 'MD');

assert.strictEqual(filter.findRule({ name: 'Panetteria La Romana' }, config), null);
assert.strictEqual(filter.findRule({ name: 'MD Service' }, config), null);
assert.strictEqual(filter.findRule({ name: 'Studio Timone' }, config), null);

const customConfig = {
  matchingFields: ['owner'],
  rules: [
    { label: 'Comune di prova', category: 'Scarto manuale', reason: 'Non target', terms: ['comune di prova'] }
  ]
};
const customMatch = filter.findRule({ owner: 'Comune di prova - patrimonio' }, customConfig);
assert.strictEqual(customMatch.label, 'Comune di prova');
assert.strictEqual(customMatch.category, 'Scarto manuale');

const declaredLarge = filter.findRule({ employees: '251', turnover: '51 milioni' }, config);
assert.strictEqual(declaredLarge.reason, 'declared_size');
assert.strictEqual(declaredLarge.category, 'Grande impresa');

assert.strictEqual(filter.findRule({ employees: '251', turnover: '49 milioni' }, config), null);

console.log('entity exclusion filter tests passed');
