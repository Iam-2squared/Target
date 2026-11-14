'use strict';
const {HttpError} = require('./errors.cjs');

function configurationError() {
  return new HttpError(503, '共有サーバーの設定が未完了です。', 'CONFIGURATION_REQUIRED');
}

function origin(value, test) {
  let parsed;
  try { parsed = new URL(value); } catch { throw configurationError(); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
      (parsed.protocol !== 'https:' && !(test && loopback && parsed.protocol === 'http:'))) {
    throw configurationError();
  }
  return parsed.origin;
}

function getConfig() {
  const test = process.env.NODE_ENV === 'test' && process.env.VERCEL !== '1';
  const secrets = ['TARGET_RPC_SECRET', 'TARGET_COOKIE_SECRET', 'KGS_TARGET_INTEGRATION_SECRET'];
  if (secrets.some(key => typeof process.env[key] !== 'string' || process.env[key].length < 32 || process.env[key].length > 4096) ||
      !process.env.KGS_IDENTITY_URL || !process.env.TARGET_ALLOWED_ORIGINS) throw configurationError();
  if (process.env.TARGET_RPC_SECRET.length > 256 || new Set(secrets.map(key => process.env[key])).size !== secrets.length) throw configurationError();
  const origins = process.env.TARGET_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length || origins.length > 20 || origins.some(value => origin(value, test) !== value)) throw configurationError();
  const kgsOrigin = origin(process.env.KGS_IDENTITY_URL, test);
  const databaseUrl = process.env.TARGET_DATABASE_URL;
  let supabaseOrigin;
  let publishableKey;
  if (databaseUrl) {
    let database;
    try { database = new URL(databaseUrl); } catch { throw configurationError(); }
    if (!test || !['postgres:', 'postgresql:'].includes(database.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
        !/^\/target_[a-z0-9_]+_test$/.test(database.pathname)) throw configurationError();
  } else {
    if (!process.env.TARGET_SUPABASE_URL || !process.env.TARGET_SUPABASE_PUBLISHABLE_KEY) throw configurationError();
    supabaseOrigin = origin(process.env.TARGET_SUPABASE_URL, false);
    if (!/^[a-z0-9]+\.supabase\.co$/.test(new URL(supabaseOrigin).hostname)) throw configurationError();
    publishableKey = process.env.TARGET_SUPABASE_PUBLISHABLE_KEY;
    if (publishableKey.length < 20 || publishableKey.length > 4096) throw configurationError();
  }
  return {
    test, origins, kgsOrigin, databaseUrl, supabaseOrigin, publishableKey,
    rpcSecret: process.env.TARGET_RPC_SECRET,
    cookieSecret: process.env.TARGET_COOKIE_SECRET,
    integrationSecret: process.env.KGS_TARGET_INTEGRATION_SECRET,
    sessionCookie: test ? 'target_session' : '__Host-target_session',
    attemptCookie: test ? 'target_attempt' : '__Host-target_attempt'
  };
}

function checkOrigin(req, config = getConfig()) {
  const requestOrigin = req.headers?.origin;
  if (!config.origins.includes(requestOrigin) || req.headers?.['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'この送信元からは操作できません。', 'ORIGIN_REJECTED');
  }
  // An allowed Preview cannot submit another alias's credentials cross-origin.
  if (new URL(requestOrigin).host !== req.headers?.host) {
    throw new HttpError(403, 'この送信元からは操作できません。', 'ORIGIN_REJECTED');
  }
}

module.exports = {getConfig, checkOrigin};
