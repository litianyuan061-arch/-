'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getIceServers, provider, dropPort53 } = require('../server/ice');

test('no TURN configured falls back to STUN only', async () => {
  const r = await getIceServers({});
  assert.strictEqual(r.relay, false);
  assert.ok(r.iceServers.every((s) => [].concat(s.urls).every((u) => u.startsWith('stun:'))));
});

test('provider detection', () => {
  assert.strictEqual(provider({ CLOUDFLARE_TURN_KEY_ID: 'a', CLOUDFLARE_TURN_API_TOKEN: 'b' }), 'cloudflare');
  assert.strictEqual(provider({ METERED_DOMAIN: 'x.metered.live', METERED_API_KEY: 'k' }), 'metered');
  assert.strictEqual(provider({ TURN_URLS: 'turn:a:3478' }), 'static');
  assert.strictEqual(provider({ CLOUDFLARE_TURN_KEY_ID: 'a' }), null);
});

test('static TURN servers are passed through', async () => {
  const r = await getIceServers({
    TURN_URLS: 'turn:turn.example.com:3478, turns:turn.example.com:5349',
    TURN_USERNAME: 'u',
    TURN_CREDENTIAL: 'p',
  });
  assert.strictEqual(r.relay, true);
  const turn = r.iceServers.find((s) => s.username === 'u');
  assert.deepStrictEqual(turn.urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349']);
  assert.strictEqual(turn.credential, 'p');
});

test('port 53 urls are dropped because browsers block them', () => {
  const out = dropPort53([
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'], username: 'u' },
    { urls: 'stun:stun.cloudflare.com:53' },
  ]);
  assert.deepStrictEqual(out, [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u' }]);
});
