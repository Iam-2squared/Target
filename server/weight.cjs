'use strict';
const {HttpError}=require('./errors.cjs');
const store=require('./store.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SESSION=/^[A-Za-z0-9_-]{8,80}$/;
const RATE=1000,MAX_MONEY=10000000000000;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const invalid=()=>new HttpError(400,'送信内容を確認してください。','INVALID_REQUEST');
const unavailable=()=>new HttpError(503,'Weightの獲得轟を確認できませんでした。','WEIGHT_UNAVAILABLE');
const money=n=>Number.isSafeInteger(n)&&n>=0&&n<=MAX_MONEY&&n%10===0;
function parseInput(action,input){
  const keys=action==='credit'?['memberId','name','sessionId','reps']:['memberId','name'];
  if(!['status','credit'].includes(action)||!exact(input,keys)||typeof input.memberId!=='string'||!UUID.test(input.memberId)||
    typeof input.name!=='string'||input.name.length>100||!input.name.trim()||input.name.trim().length>20||
    (action==='credit'&&(typeof input.sessionId!=='string'||!SESSION.test(input.sessionId)||!Number.isSafeInteger(input.reps)||input.reps<1||input.reps>5000)))throw invalid();
  return{memberId:input.memberId.toLowerCase(),name:input.name.trim(),...(action==='credit'?{sessionId:input.sessionId,reps:input.reps}:{})};
}
function validateResult(action,value,input){
  const keys=['weightIncome','totalIncome','balance',...(action==='credit'?['sessionId','reps','creditedAmount','replayed']:[])];
  // Weight income is lifetime gross earnings. A later authorized adjustment of
  // the shared total must not rewrite these permanent exercise receipts.
  if(!exact(value,keys)||!['weightIncome','totalIncome','balance'].every(key=>money(value[key]))||
    value.weightIncome%RATE!==0||value.balance>value.totalIncome||
    (action==='credit'&&(value.sessionId!==input.sessionId||value.reps!==input.reps||value.creditedAmount!==input.reps*RATE||typeof value.replayed!=='boolean')))throw unavailable();
  return value;
}
async function perform(action,input){
  const parsed=parseInput(action,input);
  await Promise.all([require('./calculus.cjs').refreshMembers([parsed.memberId]),require('./birthday.cjs').refresh()]);
  return validateResult(action,await store.weightRpc(action,parsed),parsed);
}
module.exports={parseInput,validateResult,perform,RATE,SESSION};
