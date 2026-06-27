const assert = require('assert');
const http = require('http');

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function main() {
  const arcgisRequests = [];
  const fakeArcgis = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    arcgisRequests.push(requestUrl);

    assert.strictEqual(requestUrl.pathname, '/FeatureServer/0/query');
    assert.strictEqual(requestUrl.searchParams.get('where'), "COD_AC='AC253E00019'");
    assert.strictEqual(requestUrl.searchParams.get('f'), 'geojson');
    assert.strictEqual(requestUrl.searchParams.get('returnGeometry'), 'true');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 1,
          properties: {
            OBJECTID: 1,
            COD_AC: 'AC253E00019',
            NOME: 'Area test'
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [9.52, 45.57],
              [9.53, 45.57],
              [9.53, 45.58],
              [9.52, 45.58],
              [9.52, 45.57]
            ]]
          }
        }
      ]
    }));
  });

  const fakeArcgisPort = await listen(fakeArcgis);
  process.env.GSE_FEATURE_LAYER_URLS = `http://127.0.0.1:${fakeArcgisPort}/FeatureServer/0`;

  const { app, isValidGseAreaCode } = require('../server');
  const appServer = http.createServer(app);
  const appPort = await listen(appServer);

  try {
    assert.strictEqual(isValidGseAreaCode('AC253E00019'), true);
    assert.strictEqual(isValidGseAreaCode('AC001E01364'), true);
    assert.strictEqual(isValidGseAreaCode('bad-code'), false);

    const validResponse = await fetch(`http://127.0.0.1:${appPort}/api/gse-area?code=AC253E00019`);
    assert.strictEqual(validResponse.status, 200);
    const validBody = await validResponse.json();
    assert.strictEqual(validBody.meta.lookupField, 'COD_AC');
    assert.strictEqual(validBody.meta.code, 'AC253E00019');
    assert.strictEqual(validBody.features[0].properties.COD_AC, 'AC253E00019');
    assert.strictEqual(validBody.features[0].properties.GSE_LOOKUP_FIELD, 'COD_AC');
    assert.strictEqual(arcgisRequests.length, 1);

    const invalidResponse = await fetch(`http://127.0.0.1:${appPort}/api/gse-area?code=bad-code`);
    assert.strictEqual(invalidResponse.status, 400);

    const osmMissingBody = await fetch(`http://127.0.0.1:${appPort}/api/osm-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.strictEqual(osmMissingBody.status, 400);
  } finally {
    await close(appServer);
    await close(fakeArcgis);
  }
}

main()
  .then(() => console.log('backend route tests passed'))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
