'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const store = require('../server/store.cjs');

test('all supported Section achievers fit the mastery transport without raising unrelated response limits', async () => {
  const random = () => crypto.randomBytes(32).toString('base64url');
  const settings = {
    NODE_ENV: 'production', VERCEL: '1', TARGET_DATABASE_URL: undefined,
    TARGET_RPC_SECRET: random(), TARGET_COOKIE_SECRET: random(), KGS_TARGET_INTEGRATION_SECRET: random(),
    KGS_IDENTITY_URL: 'https://class.example.invalid', TARGET_ALLOWED_ORIGINS: 'https://target.example.invalid',
    TARGET_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    TARGET_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + random()
  };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    const achievers = Array.from({length: 500}, (_, i) => ({
      memberId: '00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'),
      // Maximum JSON escaping of a name permitted by the private SQL profile.
      name: '\u0001'.repeat(20), achievedAt: '2026-11-09T08:00:00.000Z'
    }));
    const snapshot = {book: 'target1900', reviewNumbers: [], sections: Array.from({length: 19}, (_, i) => ({
      section: i + 1, from: i * 100 + 1, to: (i + 1) * 100, total: 100,
      mastered: 100, percent: 100, reviewCount: 0, achievers
    }))};
    let raw = JSON.stringify(snapshot);
    assert(Buffer.byteLength(raw) > 2 * 1024 * 1024);
    global.fetch = async () => new Response(raw, {headers: {'Content-Type': 'application/json'}});
    assert.deepEqual(await store.rpc('mastery', {book: 'target1900'}), snapshot);
    await assert.rejects(store.rpc('ranking'), error => error.code === 'STORAGE_UNAVAILABLE');
    await assert.rejects(store.shopRpc('wallet'), error => error.code === 'STORAGE_UNAVAILABLE');
    raw = JSON.stringify({oversized: 'x'.repeat(3 * 1024 * 1024)});
    await assert.rejects(store.rpc('mastery', {book: 'target1900'}), error => error.code === 'STORAGE_UNAVAILABLE');
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
