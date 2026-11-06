'use strict';
const {performance}=require('node:perf_hooks');
const {HttpError} = require('./errors.cjs');
const {getConfig, checkOrigin} = require('./config.cjs');
const store = require('./store.cjs');
const identity = require('./identity.cjs');
const shop = require('./shop.cjs');
const {validateQuizInput, generateQuestions} = require('./questions.cjs');
const PROCESSING_STARTED=Symbol('target.processing.started');

const HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
};

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) {
    throw new HttpError(415, 'JSON形式で送信してください。', 'CONTENT_TYPE');
  }
  let bytes;
  if (req.body !== undefined) {
    bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw new HttpError(413, '送信容量の上限を超えています。', 'BODY_LIMIT');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (bytes.length > 8192) throw new HttpError(413, '送信容量の上限を超えています。', 'BODY_LIMIT');
  let result;
  try { result = JSON.parse(bytes.toString('utf8')); }
  catch { throw new HttpError(400, '送信内容を読み込めませんでした。', 'BAD_JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new HttpError(400, '送信内容を確認してください。', 'BAD_JSON');
  }
  return result;
}

function exactKeys(body, keys) {
  return Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
}

function send(res, status, result) {
  const payload = Buffer.from(JSON.stringify(result));
  if (payload.length > 1024 * 1024) throw new Error('response limit');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', payload.length);
  // Fresh even for an idempotent answer replay: clients must never start a new
  // 15.9-second interval from a historical receipt or their own wall clock.
  res.setHeader('X-Target-Now', String(Date.now()));
  // Let the same-origin client separate server/auth/DB wait from network time.
  // The start belongs to this response and can never be supplied by the caller.
  const started=res[PROCESSING_STARTED];
  res.setHeader('X-Target-Processing-Ms',Number.isFinite(started)?Math.max(0,performance.now()-started).toFixed(3):'0');
  res.end(payload);
}

async function handler(req, res) {
  res[PROCESSING_STARTED]=performance.now();
  for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
  try {
    const config = getConfig();
    const url = new URL(req.url, 'https://target.invalid');
    const route = url.pathname === '/api/index' ? url.searchParams.get('route') : null;
    const pathname = route ? '/api/' + route.replace(/^\/+/, '') : url.pathname;
    if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'この操作には対応していません。', 'METHOD');
    const shopAction={'/api/integrations/kgs/wallet':'wallet','/api/integrations/kgs/gacha':'draw'}[pathname];
    if(shopAction&&req.method==='POST'){
      // Only the KGS service may assert an already authenticated class member.
      // Authorize before parsing body, rate allocation or the Origin bypass.
      shop.authorize(req,config);
      return send(res,200,await shop.perform(shopAction,await readJson(req)));
    }
    if (req.method === 'POST') checkOrigin(req, config);

    if (pathname === '/api/session' && req.method === 'GET') {
      const token = identity.sessionToken(req, config);
      if (!token) return send(res, 200, {member: null, correctCount: 0, totalPoints: 0,bonus:null,...shop.guestWallet()});
      let member;
      try { member = await identity.requireMember(req, res, config); }
      catch (error) {
        if (error instanceof HttpError && error.status === 401) return send(res, 200, {member: null, correctCount: 0, totalPoints: 0,bonus:null,...shop.guestWallet()});
        throw error;
      }
      const profile = await store.rpc('profile', {memberId: member.id, name: member.name});
      const wallet=await shop.wallet(member);
      return send(res, 200, {member: {name: member.name}, correctCount: profile.correctCount, totalPoints: wallet.totalIncome,bonus:profile.bonus??null,...wallet});
    }
    if (pathname === '/api/ranking' && req.method === 'GET') return send(res, 200, await store.rpc('ranking'));
    if (pathname === '/api/mastery' && req.method === 'GET') {
      const book = url.searchParams.get('book');
      const internalRoutes = url.searchParams.getAll('route');
      // Vercel may preserve /api/mastery in req.url while adding the rewrite's
      // route=mastery query. Accept only that exact optional routing metadata.
      if (!['target1900', 'target1000'].includes(book) || url.searchParams.getAll('book').length !== 1 ||
          internalRoutes.length > 1 || (internalRoutes.length === 1 && internalRoutes[0] !== 'mastery') ||
          [...url.searchParams.keys()].some(key => key !== 'book' && key !== 'route')) {
        throw new HttpError(400, '教材を選んでください。', 'INVALID_BOOK');
      }
      const member = await identity.requireMember(req, res, config);
      return send(res, 200, await store.rpc('mastery', {memberId: member.id, name: member.name, book}));
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readJson(req);
      const number = typeof body.attendanceNumber === 'number' ? body.attendanceNumber :
        typeof body.attendanceNumber === 'string' && /^[0-9]{1,2}$/.test(body.attendanceNumber) ? Number(body.attendanceNumber) : NaN;
      if (!exactKeys(body, ['attendanceNumber', 'accountPin']) || !Number.isInteger(number) ||
          !((number >= 1 && number <= 40) || number === 99) || typeof body.accountPin !== 'string' || !/^[0-9]{4}$/.test(body.accountPin)) {
        throw new HttpError(400, '出席番号と4桁のPINを確認してください。', 'INVALID_ACCOUNT_REQUEST');
      }
      const attemptId = identity.attemptIdentity(req, res, config);
      await store.rpc('rate', {identifier: identity.digest(attemptId, 'login-rate', config)});
      const result = await identity.callIdentity('login', {attendanceNumber: number, accountPin: body.accountPin, attemptId}, config);
      body.accountPin = '';
      const profile = await store.rpc('profile', {memberId: result.member.id, name: result.member.name});
      const wallet=await shop.wallet(result.member);
      identity.setSession(res, result.token, result.expiresAt, config);
      return send(res, 200, {member: {name: result.member.name}, correctCount: profile.correctCount, totalPoints: wallet.totalIncome,bonus:profile.bonus??null,...wallet});
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      const body = await readJson(req);
      if (!exactKeys(body, [])) throw new HttpError(400, '送信内容を確認してください。', 'BAD_JSON');
      const token = identity.sessionToken(req, config);
      if (token) await identity.callIdentity('logout', {token}, config);
      identity.clearSession(res, config);
      return send(res, 200, {ok: true});
    }
    if (pathname === '/api/quiz/start' && req.method === 'POST') {
      const body = validateQuizInput(await readJson(req));
      const member = await identity.requireMember(req, res, config);
      const questions = generateQuestions(body);
      return send(res, 200, await store.rpc('start', {memberId: member.id, name: member.name,
        requestId: body.requestId, book: body.book, direction: body.direction, from: body.from, to: body.to, questions}));
    }
    if (pathname === '/api/quiz/review/start' && req.method === 'POST') {
      const body = validateQuizInput(await readJson(req));
      const member = await identity.requireMember(req, res, config);
      const input = {memberId: member.id, name: member.name, requestId: body.requestId,
        book: body.book, direction: body.direction, from: body.from, to: body.to, count: body.count};
      // Resolve a prior start before looking at today's pool: its last word may
      // already be mastered on another device. Candidate IDs never come from UI.
      const candidate = await store.rpc('review_start', input);
      if (candidate.quizId) return send(res, 200, candidate);
      if (!Array.isArray(candidate.reviewNumbers)) throw new HttpError(503, '解き直しの対象を確認できませんでした。', 'REVIEW_UNAVAILABLE');
      const questions = generateQuestions(body, candidate.reviewNumbers);
      return send(res, 200, await store.rpc('review_start', {...input, questions}));
    }
    if (pathname === '/api/quiz/answer' && req.method === 'POST') {
      const body = await readJson(req);
      const keys = ['quizId', 'questionId', 'choiceId', 'requestId'];
      if (!exactKeys(body, keys) || keys.some(key => typeof body[key] !== 'string' || !identity.UUID.test(body[key]))) {
        throw new HttpError(400, '回答内容を確認してください。', 'INVALID_ANSWER');
      }
      const member = await identity.requireMember(req, res, config);
      return send(res, 200, await store.rpc('answer', {memberId: member.id, name: member.name, ...body}));
    }
    throw new HttpError(404, '見つかりません。', 'NOT_FOUND');
  } catch (error) {
    if (res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    const safe = error instanceof HttpError;
    if (!safe) console.error(JSON.stringify({event: 'target_api_error', code: 'INTERNAL'}));
    if (safe && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    return send(res, safe ? error.status : 503, {error: {
      code: safe ? error.code : 'INTERNAL',
      message: safe ? error.message : '共有サーバーで処理できませんでした。時間をおいて再試行してください。',
      ...(safe && error.retryAfter ? {retryAfter: error.retryAfter} : {})
    }});
  }
}

module.exports = {handler, readJson, exactKeys};
