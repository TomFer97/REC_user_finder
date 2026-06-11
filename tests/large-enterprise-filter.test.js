const assert = require('assert');
const fs = require('fs');
const path = require('path');

const filter = require('../webapp/large-enterprise-filter.js');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '../webapp/data/large-enterprises.json'), 'utf8')).rules;

assert.strictEqual(filter.findRule({ name: 'Carrefour Market' }, rules).label, 'Carrefour');
assert.strictEqual(filter.findRule({ brand: 'Amplifon' }, rules).label, 'Amplifon');
assert.strictEqual(filter.findRule({ brand: 'MD' }, rules).label, 'MD');

assert.strictEqual(filter.findRule({ name: 'Panetteria La Romana' }, rules), null);
assert.strictEqual(filter.findRule({ name: 'MD Service' }, rules), null);
assert.strictEqual(filter.findRule({ name: 'Studio Timone' }, rules), null);

const declaredLarge = filter.findRule({ employees: '251', turnover: '51 milioni' }, rules);
assert.strictEqual(declaredLarge.reason, 'declared_size');

assert.strictEqual(filter.findRule({ employees: '251', turnover: '49 milioni' }, rules), null);

console.log('large-enterprise-filter tests passed');
