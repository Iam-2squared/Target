'use strict';
const crypto=require('node:crypto');
const {HttpError}=require('./errors.cjs');
const {getConfig}=require('./config.cjs');
const store=require('./store.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STICKERS=Object.freeze(['youth','sunglasses','night','love']);
const PRICE=100000,LEGACY_PRICE=10000,MAX_POINTS=10000000000000;
function authorize(req,config=getConfig()){
  const supplied=typeof req.headers?.authorization==='string'&&req.headers.authorization.length<=8192?req.headers.authorization:'';
  const expected=crypto.createHash('sha256').update('Bearer '+config.integrationSecret).digest();
  const actual=crypto.createHash('sha256').update(supplied).digest();
  if(!crypto.timingSafeEqual(expected,actual))throw new HttpError(404,'見つかりません。','NOT_FOUND');
}
function parseInput(action,input){
  const keys=action==='draw'?['memberId','name','requestId']:['memberId','name'];
  if(action==='draw'&&input&&Object.hasOwn(input,'expectedPrice'))keys.push('expectedPrice');
  if(!['wallet','draw'].includes(action)||!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))||
      typeof input.memberId!=='string'||!UUID.test(input.memberId)||typeof input.name!=='string'||
      !input.name.trim()||input.name.trim().length>20||
      (action==='draw'&&(typeof input.requestId!=='string'||!UUID.test(input.requestId)||
        (Object.hasOwn(input,'expectedPrice')&&![LEGACY_PRICE,PRICE].includes(input.expectedPrice))))){
    throw new HttpError(400,'送信内容を確認してください。','INVALID_REQUEST');
  }
  return{memberId:input.memberId,name:input.name.trim(),...(action==='draw'?{requestId:input.requestId,...(Object.hasOwn(input,'expectedPrice')?{expectedPrice:input.expectedPrice}:{})}:{})};
}
// With four unique stickers, a mixture of original10k and new100k costs has
// exactly these possible totals. Never rewrite historical spending.
function validHistoricalSpend(spent,count){
  return spent>=count*LEGACY_PRICE&&spent<=count*PRICE&&(spent-count*LEGACY_PRICE)%(PRICE-LEGACY_PRICE)===0;
}
function validateWallet(value,{requestId}={}){
  const points=key=>Number.isSafeInteger(value?.[key])&&value[key]>=0&&value[key]<=MAX_POINTS&&value[key]%100===0;
  if(!value||typeof value!=='object'||Array.isArray(value)||!['balance','totalIncome','spent'].every(points)||
      value.balance+value.spent!==value.totalIncome||![LEGACY_PRICE,PRICE].includes(value.price)||
      !Array.isArray(value.ownedStickers)||value.ownedStickers.length>STICKERS.length||
      value.ownedStickers.some(id=>!STICKERS.includes(id))||new Set(value.ownedStickers).size!==value.ownedStickers.length||
      !validHistoricalSpend(value.spent,value.ownedStickers.length)||
      (requestId&&(value.requestId?.toLowerCase()!==requestId.toLowerCase()||!STICKERS.includes(value.stickerId)||!value.ownedStickers.includes(value.stickerId)||
        (!Object.hasOwn(value,'cost')&&value.price!==LEGACY_PRICE)||(Object.hasOwn(value,'cost')&&![LEGACY_PRICE,PRICE].includes(value.cost))||!validHistoricalSpend(value.spent-(value.cost??LEGACY_PRICE),value.ownedStickers.length-1)))){
    throw new HttpError(503,'保有金額を確認できませんでした。再試行してください。','SHOP_UNAVAILABLE');
  }
  return{balance:value.balance,totalIncome:value.totalIncome,spent:value.spent,price:value.price,
    ownedStickers:STICKERS.filter(id=>value.ownedStickers.includes(id)),
    ...(requestId?{requestId:value.requestId,stickerId:value.stickerId,cost:value.cost??LEGACY_PRICE}:{})};
}
async function wallet(member){
  const input=parseInput('wallet',{memberId:member?.id,name:member?.name});
  return validateWallet(await store.shopRpc('wallet',input));
}
async function perform(action,input){
  const parsed=parseInput(action,input);
  // Omitting an acknowledged10k price remains compatible with the old DB.
  // The new DB interprets omission as10k, so an old screen cannot pay100k.
  const forwarded={...parsed};if(forwarded.expectedPrice===LEGACY_PRICE)delete forwarded.expectedPrice;
  return validateWallet(await store.shopRpc(action,forwarded),action==='draw'?{requestId:parsed.requestId}:{});
}
function guestWallet(){return{balance:0,totalIncome:0,spent:0,ownedStickers:[],price:PRICE};}
module.exports={authorize,parseInput,validateWallet,wallet,perform,guestWallet,STICKERS,PRICE,LEGACY_PRICE,validHistoricalSpend};
