'use strict';
const crypto=require('node:crypto');
const {HttpError}=require('./errors.cjs');
const {getConfig}=require('./config.cjs');
const store=require('./store.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STICKERS=Object.freeze(['youth','sunglasses','night','love','goodnight','hang-in-there','can-you-hear','go','sleepy','screenshot','love-first','no-showoff','chuckle','red-face','whoa','secret','how-about-it']);
const LEGACY_STICKERS=Object.freeze(STICKERS.slice(0,4)),CATALOG_VERSION=2;
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
  if(action==='draw'&&input&&Object.hasOwn(input,'expectedCatalogVersion'))keys.push('expectedCatalogVersion');
  if(!['wallet','draw'].includes(action)||!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))||
      typeof input.memberId!=='string'||!UUID.test(input.memberId)||typeof input.name!=='string'||
      !input.name.trim()||input.name.trim().length>20||
      (action==='draw'&&(typeof input.requestId!=='string'||!UUID.test(input.requestId)||
        (Object.hasOwn(input,'expectedPrice')&&![LEGACY_PRICE,PRICE].includes(input.expectedPrice))||
        (Object.hasOwn(input,'expectedCatalogVersion')&&![1,CATALOG_VERSION].includes(input.expectedCatalogVersion))))){
    throw new HttpError(400,'送信内容を確認してください。','INVALID_REQUEST');
  }
  return{memberId:input.memberId,name:input.name.trim(),...(action==='draw'?{requestId:input.requestId,...(Object.hasOwn(input,'expectedPrice')?{expectedPrice:input.expectedPrice}:{}),...(Object.hasOwn(input,'expectedCatalogVersion')?{expectedCatalogVersion:input.expectedCatalogVersion}:{})}:{})};
}
// Only the original four may have historical10k receipts. New catalog items
// always cost100k; this still accepts every authentic mixed-price history.
function validHistoricalSpend(spent,count,legacyCount=count){
  return spent>=count*PRICE-legacyCount*(PRICE-LEGACY_PRICE)&&spent<=count*PRICE&&(spent-count*LEGACY_PRICE)%(PRICE-LEGACY_PRICE)===0;
}
function validateWallet(value,{requestId}={}){
  const hasVersion=!!value&&Object.hasOwn(value,'catalogVersion'),hasSize=!!value&&Object.hasOwn(value,'catalogSize');
  const catalogVersion=hasVersion?value.catalogVersion:1,catalogSize=hasSize?value.catalogSize:LEGACY_STICKERS.length;
  const catalog=catalogVersion===1?LEGACY_STICKERS:STICKERS;
  const legacyCount=ids=>ids.filter(id=>LEGACY_STICKERS.includes(id)).length;
  const points=key=>Number.isSafeInteger(value?.[key])&&value[key]>=0&&value[key]<=MAX_POINTS&&value[key]%100===0;
  if(!value||typeof value!=='object'||Array.isArray(value)||!['balance','totalIncome','spent'].every(points)||
      value.balance+value.spent!==value.totalIncome||![LEGACY_PRICE,PRICE].includes(value.price)||
      hasVersion!==hasSize||!((catalogVersion===1&&catalogSize===4)||(catalogVersion===CATALOG_VERSION&&catalogSize===STICKERS.length))||
      !Array.isArray(value.ownedStickers)||value.ownedStickers.length>catalogSize||
      value.ownedStickers.some(id=>!catalog.includes(id))||new Set(value.ownedStickers).size!==value.ownedStickers.length||
      !validHistoricalSpend(value.spent,value.ownedStickers.length,legacyCount(value.ownedStickers))||
      (requestId&&(value.requestId?.toLowerCase()!==requestId.toLowerCase()||!STICKERS.includes(value.stickerId)||!value.ownedStickers.includes(value.stickerId)||
        (!Object.hasOwn(value,'cost')&&value.price!==LEGACY_PRICE)||(Object.hasOwn(value,'cost')&&![LEGACY_PRICE,PRICE].includes(value.cost))||(!LEGACY_STICKERS.includes(value.stickerId)&&(value.cost??LEGACY_PRICE)!==PRICE)||!validHistoricalSpend(value.spent-(value.cost??LEGACY_PRICE),value.ownedStickers.length-1,legacyCount(value.ownedStickers.filter(id=>id!==value.stickerId)))))){
    throw new HttpError(503,'保有金額を確認できませんでした。再試行してください。','SHOP_UNAVAILABLE');
  }
  return{balance:value.balance,totalIncome:value.totalIncome,spent:value.spent,price:value.price,catalogVersion,catalogSize,
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
  // A version1 acknowledgement remains compatible before catalog activation;
  // the new DB rejects its omission before committing any new-item purchase.
  if(forwarded.expectedCatalogVersion===1)delete forwarded.expectedCatalogVersion;
  return validateWallet(await store.shopRpc(action,forwarded),action==='draw'?{requestId:parsed.requestId}:{});
}
function guestWallet(){return{balance:0,totalIncome:0,spent:0,ownedStickers:[],price:PRICE,catalogVersion:CATALOG_VERSION,catalogSize:STICKERS.length};}
module.exports={authorize,parseInput,validateWallet,wallet,perform,guestWallet,STICKERS,LEGACY_STICKERS,CATALOG_VERSION,PRICE,LEGACY_PRICE,validHistoricalSpend};
