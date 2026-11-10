'use strict';
const crypto=require('node:crypto');
const {getConfig}=require('./config.cjs');
const {HttpError}=require('./errors.cjs');
const {UUID}=require('./identity.cjs');
const store=require('./store.cjs');
const AMOUNT=1000000,LEGACY_AMOUNT=100000,CUTOVER='2026-11-11',MAX_BATCH=100,FOREGROUND_MS=8000,CRON_MS=22000;
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const invalid=()=>new HttpError(400,'送信内容を確認してください。','INVALID_REQUEST');
const unavailable=()=>new HttpError(503,'誕生日プレゼントを確認できませんでした。時間をおいて再試行してください。','BIRTHDAY_GIFT_UNAVAILABLE');
const date=value=>typeof value==='string'&&/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const member=value=>typeof value==='string'&&UUID.test(value);
let foregroundTask;
function authorizeCron(req){
  const secret=process.env.CRON_SECRET;
  const supplied=typeof req.headers?.authorization==='string'&&req.headers.authorization.length<=8192?req.headers.authorization:'';
  const digest=value=>crypto.createHash('sha256').update(value).digest();
  if(typeof secret!=='string'||secret.length<32||secret.length>4096||!crypto.timingSafeEqual(digest(supplied),digest('Bearer '+secret)))throw new HttpError(404,'見つかりません。','NOT_FOUND');
}
function parseInput(action,value){
  if(!['status','seen'].includes(action)||!exact(value,action==='seen'?['memberId','name','giftYear']:['memberId','name'])||!member(value.memberId)||
    typeof value.name!=='string'||!value.name.trim()||value.name.trim().length>20||
    (action==='seen'&&(!Number.isSafeInteger(value.giftYear)||value.giftYear<1||value.giftYear>9999)))throw invalid();
  return {memberId:value.memberId.toLowerCase(),...(action==='seen'?{giftYear:value.giftYear}:{})};
}
function readQuery(req,path){
  const expected=path.replace(/^\/api\//,''),url=new URL(req.url,'https://target.invalid'),values=new Map();
  const add=(key,value)=>{
    if(!['route','path'].includes(key)||typeof value!=='string'||value.replace(/^\/+/, '')!==expected||values.has(key)&&values.get(key)!==value)throw invalid();
    values.set(key,value);
  };
  for(const key of new Set(url.searchParams.keys())){const entries=url.searchParams.getAll(key);if(entries.length!==1)throw invalid();add(key,entries[0]);}
  if(req.query!==undefined&&req.query!==null){
    if(typeof req.query!=='object'||Array.isArray(req.query))throw invalid();
    for(const[key,value]of Object.entries(req.query)){const entries=Array.isArray(value)?value:[value];if(entries.length!==1)throw invalid();add(key,entries[0]);}
  }
}
function parseStatus(value){
  if(!exact(value,['gift']))throw unavailable();
  const gift=value.gift;
  if(gift!==null&&(!exact(gift,['giftYear','birthdayDate','amount','seen'])||!Number.isSafeInteger(gift.giftYear)||gift.giftYear<1000||gift.giftYear>9999||
    !date(gift.birthdayDate)||Number(gift.birthdayDate.slice(0,4))!==gift.giftYear||![LEGACY_AMOUNT,...(gift.birthdayDate>=CUTOVER?[AMOUNT]:[])].includes(gift.amount)||typeof gift.seen!=='boolean'))throw unavailable();
  return value;
}
function parseSource(value){
  if(!exact(value,['gifts','hasMore'])||!Array.isArray(value.gifts)||value.gifts.length>MAX_BATCH||typeof value.hasMore!=='boolean'||value.hasMore&&value.gifts.length===0)throw unavailable();
  const seen=new Set();
  for(const gift of value.gifts){
    if(!exact(gift,['memberId','name','birthdayDate'])||!member(gift.memberId)||typeof gift.name!=='string'||!gift.name.trim()||gift.name.trim().length>20||!date(gift.birthdayDate))throw unavailable();
    const key=gift.memberId.toLowerCase()+':'+gift.birthdayDate.slice(0,4);
    if(seen.has(key))throw unavailable();seen.add(key);
  }
  return value;
}
function remaining(deadline,maximum=4000){
  const ms=deadline-Date.now();if(ms<=0)throw unavailable();return Math.max(1,Math.min(maximum,ms));
}
async function responseJson(response,limit=32768){
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>limit)throw unavailable();
  const reader=response.body?.getReader();if(!reader)throw unavailable();
  const parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw unavailable();parts.push(Buffer.from(value));}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw unavailable();}
}
async function callSource(action,input,config,deadline){
  const suffix=action==='ack'?'/ack':'';
  const response=await fetch(config.kgsOrigin+'/api/integrations/target/birthday-gifts'+suffix,{method:'POST',redirect:'error',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.integrationSecret},body:JSON.stringify(input),
    signal:AbortSignal.timeout(remaining(deadline,action==='ack'?2500:4000))});
  if(!response.ok){await response.body?.cancel();throw unavailable();}
  const value=await responseJson(response,action==='ack'?1024:32768);
  if(action==='ack'){if(!exact(value,['ok'])||value.ok!==true)throw unavailable();return value;}
  return parseSource(value);
}
async function runRefresh({drain=false,config=getConfig()}={}){
  const deadline=Date.now()+(drain?CRON_MS:FOREGROUND_MS),result={batches:0,processed:0,granted:0,syncPending:false};
  try{
    for(let index=0;index<(drain?5:1);index++){
      const source=await callSource('pending',{},config,deadline);
      if(!source.gifts.length){result.syncPending=false;return result;}
      const posted=await store.birthdayRpc('grant',{gifts:source.gifts},{timeoutMs:remaining(deadline,8000)});
      if(!exact(posted,['granted'])||!Number.isSafeInteger(posted.granted)||posted.granted<0||posted.granted>source.gifts.length)throw unavailable();
      result.batches++;result.processed+=source.gifts.length;result.granted+=posted.granted;
      // A failed acknowledgement never rolls back credited money. The source
      // row stays pending and the permanent annual receipt absorbs its replay.
      await callSource('ack',{gifts:source.gifts.map(({memberId,birthdayDate})=>({memberId,birthdayDate}))},config,deadline);
      if(!source.hasMore){result.syncPending=false;return result;}
      result.syncPending=true;
    }
  }catch{result.syncPending=true;return result;}
  return result;
}
function refresh(options={}){
  if(options.drain)return runRefresh(options);
  if(!foregroundTask)foregroundTask=runRefresh(options).finally(()=>{foregroundTask=undefined;});
  return foregroundTask;
}
async function perform(action,input,config=getConfig()){
  const parsed=parseInput(action,input);
  const {syncPending}=await refresh({config});
  return {...parseStatus(await store.birthdayRpc(action,parsed)),syncPending};
}
module.exports={AMOUNT,authorizeCron,parseInput,readQuery,parseStatus,parseSource,refresh,perform};
