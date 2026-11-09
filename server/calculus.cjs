'use strict';
const crypto=require('node:crypto');
const {getConfig}=require('./config.cjs');
const {HttpError}=require('./errors.cjs');
const store=require('./store.cjs');
const identity=require('./identity.cjs');
const RATE=10000,MAX_SOURCE_POINTS=1000000000,MAX_MONEY=10000000000000;
const unavailable=()=>new HttpError(503,'今日の微積との連携に接続できませんでした。時間をおいて再試行してください。','CALCULUS_UNAVAILABLE');
const invalid=()=>new HttpError(400,'送信内容を確認してください。','INVALID_REQUEST');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const userId=value=>Number.isSafeInteger(value)&&value>=1&&value<=2147483647;
const money=value=>Number.isSafeInteger(value)&&value>=0&&value<=MAX_MONEY&&value%100===0;
function settings(config=getConfig(),required=true){
  const secret=process.env.CALCULUS_TARGET_INTEGRATION_SECRET;
  if(!secret){if(!required)return null;throw unavailable();}
  if(secret.length<32||secret.length>4096||[config.rpcSecret,config.cookieSecret,config.integrationSecret].includes(secret))throw unavailable();
  let url;
  try{url=new URL(process.env.CALCULUS_SOURCE_URL||'https://daily-calculus-beta.vercel.app');}catch{throw unavailable();}
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    (url.protocol!=='https:'&&!(config.test&&loopback&&url.protocol==='http:')))throw unavailable();
  return {secret,origin:url.origin};
}
function authorize(req,config=getConfig()){
  // Unconfigured bridges are indistinguishable from a rejected service key.
  // Configuration diagnostics are available only after authenticating.
  const secret=process.env.CALCULUS_TARGET_INTEGRATION_SECRET;
  const supplied=typeof req.headers?.authorization==='string'&&req.headers.authorization.length<=8192?req.headers.authorization:'';
  const hash=value=>crypto.createHash('sha256').update(value).digest();
  if(typeof secret!=='string'||secret.length<32||secret.length>4096||!crypto.timingSafeEqual(hash(supplied),hash('Bearer '+secret)))throw new HttpError(404,'見つかりません。','NOT_FOUND');
}
function parseService(action,input){
  if(!['status','link','sync'].includes(action)||!exact(input,action==='link'?['userId','proofToken']:['userId'])||!userId(input.userId)||
    (action==='link'&&(typeof input.proofToken!=='string'||!identity.TOKEN.test(input.proofToken))))throw invalid();
  return input;
}
function parseStatus(value){
  if(!exact(value,['linked','conversionRate','member','balance','totalIncome','calculusIncome','syncPending'])||
    typeof value.linked!=='boolean'||value.conversionRate!==RATE||typeof value.syncPending!=='boolean')throw unavailable();
  if(!value.linked){if(['member','balance','totalIncome','calculusIncome'].some(key=>value[key]!==null))throw unavailable();}
  else if(!exact(value.member,['id','name'])||!identity.UUID.test(value.member.id||'')||typeof value.member.name!=='string'||!value.member.name.trim()||value.member.name.length>20||
    !['balance','totalIncome','calculusIncome'].every(key=>money(value[key]))||value.balance>value.totalIncome||value.calculusIncome>value.totalIncome||value.calculusIncome%RATE!==0)throw unavailable();
  return value;
}
async function responseJson(response){
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw unavailable();
  const reader=response.body?.getReader();if(!reader)throw unavailable();
  const parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)throw unavailable();parts.push(Buffer.from(value));}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw unavailable();}
}
function parseTotals(value,ids){
  if(!exact(value,['totals'])||!Array.isArray(value.totals)||value.totals.length!==ids.length)throw unavailable();
  const expected=new Set(ids),seen=new Set();
  for(const row of value.totals){
    if(!exact(row,['userId','totalPoints','known','deleted'])||!userId(row.userId)||!expected.has(row.userId)||seen.has(row.userId)||
      !Number.isSafeInteger(row.totalPoints)||row.totalPoints<0||row.totalPoints>MAX_SOURCE_POINTS||typeof row.known!=='boolean'||typeof row.deleted!=='boolean'||
      (!row.known&&(row.totalPoints!==0||row.deleted!==true)))throw unavailable();
    seen.add(row.userId);
  }
  return value.totals;
}
async function sourceTotals(ids,config=getConfig()){
  const {secret,origin}=settings(config);
  try{
    const response=await fetch(origin+'/api/integrations/target/totals',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+secret},
      body:JSON.stringify({userIds:ids}),signal:AbortSignal.timeout(6000),redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw unavailable();}
    return parseTotals(await responseJson(response),ids);
  }catch{throw unavailable();}
}
async function refreshMembers(memberIds,config=getConfig(),required=false){
  if(!settings(config,required))return {syncPending:false};
  const result=await store.calculusRpc('links',{memberIds});
  if(!exact(result,['links'])||!Array.isArray(result.links)||result.links.length>memberIds.length)throw unavailable();
  const seen=new Set(),members=new Set(memberIds.map(id=>id.toLowerCase()));
  for(const row of result.links){
    if(!exact(row,['userId','memberId'])||!userId(row.userId)||typeof row.memberId!=='string'||!identity.UUID.test(row.memberId)||
      !members.has(row.memberId.toLowerCase())||seen.has(row.userId))throw unavailable();
    seen.add(row.userId);
  }
  if(!result.links.length)return {syncPending:false};
  let totals;
  try{totals=await sourceTotals([...seen],config);}catch{return {syncPending:true};}
  await store.calculusRpc('sync',{totals});
  return {syncPending:false};
}
async function perform(action,input,config=getConfig()){
  settings(config);const parsed=parseService(action,input);
  if(action==='link'){
    // The caller supplies proof only. Identity and source amounts are fetched
    // independently before entering the ledger transaction.
    const [proof,totals]=await Promise.all([identity.callIdentity('verify',{token:parsed.proofToken},config),sourceTotals([parsed.userId],config)]);
    return parseStatus(await store.calculusRpc('link',{...totals[0],memberId:proof.member.id,name:proof.member.name}));
  }
  const cached=parseStatus(await store.calculusRpc('status',{userId:parsed.userId}));
  if(!cached.linked)return cached;
  let totals;
  try{totals=await sourceTotals([parsed.userId],config);}catch{return {...cached,syncPending:true};}
  await store.calculusRpc('sync',{totals});
  return parseStatus(await store.calculusRpc('status',{userId:parsed.userId}));
}
function parseWealth(input){
  if(!exact(input,['memberId','name','members'])||typeof input.memberId!=='string'||!identity.UUID.test(input.memberId)||typeof input.name!=='string'||
    !input.name.trim()||input.name.trim().length>20||!Array.isArray(input.members)||input.members.length<1||input.members.length>100)throw invalid();
  const seen=new Set();
  for(const member of input.members){
    if(!exact(member,['id','name'])||typeof member.id!=='string'||!identity.UUID.test(member.id)||seen.has(member.id.toLowerCase())||
      typeof member.name!=='string'||!member.name.trim()||member.name.trim().length>20)throw invalid();
    seen.add(member.id.toLowerCase());
  }
  return input.members.map(member=>member.id.toLowerCase());
}
async function wealth(input,config=getConfig()){
  const ids=parseWealth(input),{syncPending}=await refreshMembers(ids,config,true);
  const value=await store.calculusRpc('wealth',{memberIds:ids});
  if(!exact(value,['entries'])||!Array.isArray(value.entries)||value.entries.length!==ids.length)throw unavailable();
  const expected=new Set(ids),seen=new Set();
  for(const row of value.entries){
    if(!exact(row,['memberId','totalIncome'])||!expected.has(row.memberId)||seen.has(row.memberId)||!money(row.totalIncome))throw unavailable();
    seen.add(row.memberId);
  }
  return {entries:value.entries,syncPending};
}
module.exports={authorize,perform,wealth,refreshMembers,parseService,parseStatus,parseTotals,parseWealth,settings,sourceTotals};
