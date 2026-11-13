'use strict';
const identity = require('./identity.cjs');
const store = require('./store.cjs');
const {generateQuestions} = require('./questions.cjs');
const {HttpError} = require('./errors.cjs');

const MAX_WALLET = 10000000000000;
const BOOK_SECTIONS = Object.freeze({target1900:19,target1000:10,kobun400:4});
const HP_OPTIONS = Object.freeze([50,100,150,200,300]);
const UUID = identity.UUID;
const endpoints = Object.freeze({
  '/api/battle/lobby':['GET','lobby'],
  '/api/battle/state':['GET','state'],
  '/api/battle/challenge':['POST','challenge'],
  '/api/battle/accept':['POST','accept'],
  '/api/battle/decline':['POST','decline'],
  '/api/battle/propose':['POST','propose'],
  '/api/battle/ready':['POST','ready'],
  '/api/battle/answer':['POST','answer'],
  '/api/battle/cancel':['POST','cancel']
});
function invalid(message='送信内容を確認してください。') {
  return new HttpError(400,message,'INVALID_BATTLE_REQUEST');
}
function object(value) {
  return value && typeof value==='object' && !Array.isArray(value);
}
function exact(value,required) {
  if(!object(value)||Object.keys(value).length!==required.length||
    required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)))throw invalid();
}
function uuid(value) { return typeof value==='string' && UUID.test(value); }
function settings(value) {
  if(!object(value)||!Object.hasOwn(BOOK_SECTIONS,value.book)||
    !Number.isInteger(value.fromSection)||!Number.isInteger(value.toSection)||
    value.fromSection<1||value.fromSection>value.toSection||value.toSection>BOOK_SECTIONS[value.book]||
    !Number.isSafeInteger(value.stake)||value.stake<100||value.stake>MAX_WALLET/2||value.stake%100!==0||
    !HP_OPTIONS.includes(value.initialHp)) throw invalid('教材・Section・賭け金・初期HPを確認してください。');
  return {book:value.book,fromSection:value.fromSection,toSection:value.toSection,stake:value.stake,initialHp:value.initialHp};
}
function input(action,body) {
  const fields={
    challenge:['requestId','targetId','book','fromSection','toSection','stake','initialHp'],
    accept:['requestId','matchId'],decline:['requestId','matchId'],
    propose:['requestId','matchId','expectedVersion','book','fromSection','toSection','stake','initialHp'],
    ready:['requestId','matchId','expectedVersion'],
    answer:['requestId','matchId','questionId','choiceId'],
    cancel:['requestId','matchId']
  }[action];
  if(!fields)throw invalid();
  exact(body,fields);
  if(!uuid(body.requestId)||(fields.includes('matchId')&&!uuid(body.matchId))||
     (fields.includes('targetId')&&!uuid(body.targetId))||
     (fields.includes('questionId')&&!uuid(body.questionId))||
     (fields.includes('choiceId')&&!uuid(body.choiceId))||
     (fields.includes('expectedVersion')&&(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1||body.expectedVersion>1000000)))throw invalid();
  if(['challenge','propose'].includes(action))settings(body);
  return body;
}
function matchIdInUrl(url) {
  const pairs=[...url.searchParams.entries()];
  if(pairs.length!==1||pairs[0][0]!=='matchId'||!uuid(pairs[0][1]))throw invalid('試合を選び直してください。');
  return pairs[0][1];
}
async function state(actor,matchId,sessionHash) {
  const current=await store.battleRpc('state',{...actor,matchId,sessionHash});
  if(current?.match?.status!=='playing'||current.question||!current.match?.id)return current;
  const {book,fromSection,toSection}=current.match;
  if(!Object.hasOwn(BOOK_SECTIONS,book)||!Number.isInteger(fromSection)||!Number.isInteger(toSection)||
     fromSection<1||toSection>BOOK_SECTIONS[book]||fromSection>toSection)throw new HttpError(503,'出題範囲が不正です。','BATTLE_DATA_ERROR');
  const candidate=generateQuestions({book,direction:'japanese',count:10,
    from:(fromSection-1)*100+1,to:toSection*100,requestId:cryptoRandomUuid()})[0];
  return await store.battleRpc('next',{...actor,matchId,sessionHash,question:candidate});
}
function cryptoRandomUuid() {
  return require('node:crypto').randomUUID();
}
async function dispatch({pathname,req,res,url,config,readJson}) {
  const definition=endpoints[pathname];
  if(!definition||req.method!==definition[0])throw new HttpError(404,'見つかりません。','NOT_FOUND');
  const action=definition[1];
  // The KGS session is verified on every read and mutation. Client-chosen actor IDs are ignored.
  const member=await identity.requireMember(req,res,config);
  const token=identity.sessionToken(req,config);
  if(!token)throw new HttpError(401,'ログインしてください。','AUTHENTICATION_REQUIRED');
  const sessionHash=identity.digest(token,'target-battle-session',config);
  const actor={memberId:member.id,name:member.name};
  if(action==='lobby') {
    if([...url.searchParams].length)throw invalid();
    await store.rpc('profile',actor);
    return await store.battleRpc('lobby',{...actor,sessionHash});
  }
  if(action==='state')return state(actor,matchIdInUrl(url),sessionHash);
  if([...url.searchParams].length)throw invalid();
  const body=input(action,await readJson(req));
  return await store.battleRpc(action,{...actor,...body,sessionHash});
}
module.exports={dispatch,settings,input,matchIdInUrl,BOOK_SECTIONS,HP_OPTIONS,MAX_WALLET};
