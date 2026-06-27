const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'webapp/data/gse-areas.json'), 'utf8'));
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const mainJs = fs.readFileSync(path.join(repoRoot, 'webapp/main.js'), 'utf8');

const expectedCodes = ['AC253E00019', 'AC001E01397', 'AC001E01398'];
const actualCodes = config.areas.map(area => area.code);

assert.deepStrictEqual(actualCodes, expectedCodes);

for (const area of config.areas) {
  assert.strictEqual(area.arcgisLayer, 0);
  assert.ok(area.label.includes(area.code), `Missing code in label for ${area.code}`);
  assert.ok(area.sourceRef.includes(area.code), `Missing code in sourceRef for ${area.code}`);
  assert.ok(readme.includes(area.code), `README does not mention ${area.code}`);
}

assert.strictEqual(mainJs.includes('AC001E01364'), false);
assert.strictEqual(readme.includes('AC001E01364'), false);

console.log('GSE area config tests passed');
