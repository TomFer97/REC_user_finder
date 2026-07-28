const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

test('the server starts and serves the SPA fallback route', async (t) => {
  const server = app.listen(0, '127.0.0.1');

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/percorso-di-prova`
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') || '',
    /^text\/html\b/
  );

  const body = await response.text();
  assert.match(body, /<!doctype html>/i);
});
