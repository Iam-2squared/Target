'use strict';
const {getConfig} = require('./config.cjs');
const {HttpError} = require('./errors.cjs');
let pool,mapPool;
async function mapResponseText(response,limit=512*1024){
  if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))throw new Error('response type');
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw new Error('response limit');
  const reader=response.body?.getReader();if(!reader)throw new Error('response body');
  const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw new Error('response limit');chunks.push(Buffer.from(value));}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  return Buffer.concat(chunks).toString('utf8');
}

function unpack(result) {
  if (result && typeof result === 'object' && result.error) {
    const error = result.error;
    const statuses = new Set([400, 401, 403, 404, 409, 410, 429, 503, 507]);
    const code = typeof error.code === 'string' && /^[A-Z_]{1,60}$/.test(error.code) ? error.code : 'DATABASE_REJECTED';
    const status = statuses.has(error.status) ? error.status : 503;
    const message = typeof error.message === 'string' && error.message.length <= 200 ? error.message : '共有サーバーで処理できませんでした。';
    const retryAfter = Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 && error.retryAfter <= 86400 ? error.retryAfter : undefined;
    throw new HttpError(status, message, code, {retryAfter});
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(503, '共有サーバーの応答を確認できませんでした。', 'STORAGE_UNAVAILABLE');
  return result;
}

async function runRpc(functionName, action, input = {}, options = {}) {
  const config = getConfig();
  const territory=functionName==='target_territory_rpc',map=territory||functionName==='target_map_rpc';
  const timeout=Number.isSafeInteger(options.timeoutMs)?Math.max(1,Math.min(12000,options.timeoutMs)):undefined;
  try {
    if (config.databaseUrl) {
      let active=map?mapPool:pool;
      if (!active) {
        const {Pool} = require('pg');
        active = new Pool({connectionString: config.databaseUrl, max: map?2:3, connectionTimeoutMillis: 10000,
          statement_timeout: map?25000:15000, idleTimeoutMillis: 10000, application_name: map?'target-map-test':'target-test'});
        active.on('error', () => {});
        if(map)mapPool=active;else pool=active;
      }
      const result = await active.query({text:'SELECT public.'+functionName+'($1,$2,$3::jsonb) AS result', values:[config.rpcSecret, action, JSON.stringify(input)],...(timeout?{query_timeout:timeout}:{})});
      return unpack(result.rows[0]?.result);
    }
    const headers = {'Content-Type': 'application/json', apikey: config.publishableKey};
    // New sb_publishable_* keys belong only in apikey, never a JWT bearer header.
    if (config.publishableKey.split('.').length === 3) headers.Authorization = 'Bearer ' + config.publishableKey;
    const response = await fetch(config.supabaseOrigin + '/rest/v1/rpc/' + functionName, {
      method: 'POST', headers, body: JSON.stringify({p_secret: config.rpcSecret, p_action: action, p_input: input}),
      signal: AbortSignal.timeout(timeout??(map?26000:12000)), redirect: 'error'
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(503, '共有サーバーに接続できませんでした。時間をおいて再試行してください。', 'STORAGE_UNAVAILABLE');
    }
    const raw = map?await mapResponseText(response,territory?256*1024:512*1024):await response.text();
    // Section achievements can list all 500 supported members in 19 Sections.
    // Keep their bounded, text-only response readable without truncating names.
    const responseLimit = functionName === 'target_rpc' && action === 'mastery' ? 3 * 1024 * 1024 : 1024 * 1024;
    if (Buffer.byteLength(raw) > responseLimit) throw new Error('response limit');
    return unpack(JSON.parse(raw));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, '共有サーバーに接続できませんでした。時間をおいて再試行してください。', 'STORAGE_UNAVAILABLE');
  }
}

async function closeStore() {
  const previous = [pool,mapPool];
  pool = undefined;mapPool=undefined;
  await Promise.all(previous.filter(Boolean).map(value=>value.end()));
}

const rpc=(action,input={})=>runRpc('target_rpc',action,input);
const badgesRpc=(action,input={})=>runRpc('target_badge_rpc',action,input);
const shopRpc=(action,input={})=>runRpc('target_shop_rpc',action,input);
const sellRpc=(action,input={})=>runRpc('target_sell_rpc',action,input);
const mapRpc=(action,input={})=>runRpc('target_map_rpc',action,input);
const territoryRpc=(action,input={})=>runRpc('target_territory_rpc',action,input);
const calculusRpc=(action,input={})=>runRpc('target_calculus_rpc',action,input);
const birthdayRpc=(action,input={},options={})=>runRpc('target_birthday_rpc',action,input,options);
const gamesRpc=(action,input={})=>runRpc('target_games_rpc',action,input);
const battleRpc=(action,input={})=>runRpc('target_battle_rpc',action,input);
const buzzerRpc=(action,input={})=>runRpc('target_buzzer_rpc',action,input);
const sprintRpc=(action,input={})=>runRpc('target_sprint_rpc',action,input);
module.exports = {rpc, badgesRpc, shopRpc, sellRpc, mapRpc, territoryRpc, calculusRpc, birthdayRpc, gamesRpc, battleRpc, buzzerRpc, sprintRpc, closeStore};
