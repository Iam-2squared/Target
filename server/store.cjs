'use strict';
const {getConfig} = require('./config.cjs');
const {HttpError} = require('./errors.cjs');
let pool;

function unpack(result) {
  if (result && typeof result === 'object' && result.error) {
    const error = result.error;
    const statuses = new Set([400, 401, 403, 404, 409, 429, 503, 507]);
    const code = typeof error.code === 'string' && /^[A-Z_]{1,60}$/.test(error.code) ? error.code : 'DATABASE_REJECTED';
    const status = statuses.has(error.status) ? error.status : 503;
    const message = typeof error.message === 'string' && error.message.length <= 200 ? error.message : '共有サーバーで処理できませんでした。';
    const retryAfter = Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 && error.retryAfter <= 86400 ? error.retryAfter : undefined;
    throw new HttpError(status, message, code, {retryAfter});
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(503, '共有サーバーの応答を確認できませんでした。', 'STORAGE_UNAVAILABLE');
  return result;
}

async function runRpc(functionName, action, input = {}) {
  const config = getConfig();
  try {
    if (config.databaseUrl) {
      if (!pool) {
        const {Pool} = require('pg');
        pool = new Pool({connectionString: config.databaseUrl, max: 3, connectionTimeoutMillis: 10000,
          statement_timeout: 15000, idleTimeoutMillis: 10000, application_name: 'target-test'});
        pool.on('error', () => {});
      }
      const result = await pool.query('SELECT public.'+functionName+'($1,$2,$3::jsonb) AS result', [config.rpcSecret, action, JSON.stringify(input)]);
      return unpack(result.rows[0]?.result);
    }
    const headers = {'Content-Type': 'application/json', apikey: config.publishableKey};
    // New sb_publishable_* keys belong only in apikey, never a JWT bearer header.
    if (config.publishableKey.split('.').length === 3) headers.Authorization = 'Bearer ' + config.publishableKey;
    const response = await fetch(config.supabaseOrigin + '/rest/v1/rpc/' + functionName, {
      method: 'POST', headers, body: JSON.stringify({p_secret: config.rpcSecret, p_action: action, p_input: input}),
      signal: AbortSignal.timeout(12000), redirect: 'error'
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(503, '共有サーバーに接続できませんでした。時間をおいて再試行してください。', 'STORAGE_UNAVAILABLE');
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('response limit');
    return unpack(JSON.parse(raw));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, '共有サーバーに接続できませんでした。時間をおいて再試行してください。', 'STORAGE_UNAVAILABLE');
  }
}

async function closeStore() {
  const previous = pool;
  pool = undefined;
  if (previous) await previous.end();
}

const rpc=(action,input={})=>runRpc('target_rpc',action,input);
const shopRpc=(action,input={})=>runRpc('target_shop_rpc',action,input);
module.exports = {rpc, shopRpc, closeStore};
