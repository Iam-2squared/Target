'use strict';
const crypto=require('node:crypto');
const {HttpError}=require('./errors.cjs');
const {getConfig}=require('./config.cjs');
const store=require('./store.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STICKERS=Object.freeze(['youth','sunglasses','night','love']);
const PRICE=10000,MAX_POINTS=10000000000000;
function authorize(req,config=getConfig()){
  const supplied=typeof req.headers?.authorization==='string'&&req.headers.authorization.length<=8192?req.headers.authorization:'';
  const expected=crypto.createHash('sha256').update('Bearer '+config.integrationSecret).digest();
  const actual=crypto.createHash('sha256').update(supplied).digest();
  if(!crypto.timingSafeEqual(expected,actual))throw new HttpError(404,'見つかりません。','NOT_FOUND');
}
function parseInput(action,input){
  const keys=action==='draw'?['memberId','name','requestId']:['memberId','name'];
  if(!['wallet','draw'].includes(action)||!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))||
      typeof input.memberId!=='string'||!UUID.test(input.memberId)||typeof input.name!=='string'||
      !input.name.trim()||input.name.trim().length>20||
      (action==='draw'&&(typeof input.requestId!=='string'||!UUID.test(input.requestId)))){
    throw new HttpError(400,'送信内容を確認してください。','INVALID_REQUEST');
  }
  return{memberId:input.memberId,name:input.name.trim(),...(action==='draw'?{requestId:input.requestId}:{})};
}
function validateWallet(value,{requestId}={}){
  const points=key=>Number.isSafeInteger(value?.[key])&&value[key]>=0&&value[key]<=MAX_POINTS&&value[key]%100===0;
  if(!value||typeof value!=='object'||Array.isArray(value)||!['balance','totalIncome','spent'].every(points)||
      value.balance+value.spent!==value.totalIncome||value.spent%PRICE!==0||value.price!==PRICE||
      !Array.isArray(value.ownedStickers)||value.ownedStickers.length>STICKERS.length||
      value.ownedStickers.some(id=>!STICKERS.includes(id))||new Set(value.ownedStickers).size!==value.ownedStickers.length||
      value.spent!==value.ownedStickers.length*PRICE||
      (requestId&&(value.requestId?.toLowerCase()!==requestId.toLowerCase()||!STICKERS.includes(value.stickerId)||!value.ownedStickers.includes(value.stickerId)))){
    throw new HttpError(503,'保有金額を確認できませんでした。再試行してください。','SHOP_UNAVAILABLE');
  }
  return{balance:value.balance,totalIncome:value.totalIncome,spent:value.spent,price:PRICE,
    ownedStickers:STICKERS.filter(id=>value.ownedStickers.includes(id)),
    ...(requestId?{requestId:value.requestId,stickerId:value.stickerId}:{})};
}
async function wallet(member){
  const input=parseInput('wallet',{memberId:member?.id,name:member?.name});
  return validateWallet(await store.shopRpc('wallet',input));
}
async function perform(action,input){
  const parsed=parseInput(action,input);
  return validateWallet(await store.shopRpc(action,parsed),action==='draw'?{requestId:parsed.requestId}:{});
}
function guestWallet(){return{balance:0,totalIncome:0,spent:0,ownedStickers:[],price:PRICE};}
module.exports={authorize,parseInput,validateWallet,wallet,perform,guestWallet,STICKERS,PRICE};
