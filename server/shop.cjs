'use strict';
const crypto=require('node:crypto');
const {HttpError}=require('./errors.cjs');
const {getConfig}=require('./config.cjs');
const store=require('./store.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STICKERS=Object.freeze(['youth','sunglasses','night','love','goodnight','hang-in-there','can-you-hear','go','sleepy','screenshot','love-first','no-showoff','chuckle','red-face','whoa','secret','how-about-it']);
const LEGACY_STICKERS=Object.freeze(STICKERS.slice(0,4)),CATALOG_VERSION=3;
const FRAMES=Object.freeze([['c',15],['r',10],['e',5],['l',3]].flatMap(([prefix,count])=>Array.from({length:count},(_,i)=>prefix+String(i+1).padStart(2,'0'))));
const FRAME_ODDS=Object.freeze({common:62,rare:25,epic:10,legendary:3});
const FRAME_RARITY=Object.freeze({c:'common',r:'rare',e:'epic',l:'legendary'});
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
  if(action==='draw'&&input&&Object.hasOwn(input,'itemType'))keys.push('itemType');
  if(!['wallet','draw'].includes(action)||!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))||
      typeof input.memberId!=='string'||!UUID.test(input.memberId)||typeof input.name!=='string'||
      !input.name.trim()||input.name.trim().length>20||
      (action==='draw'&&(typeof input.requestId!=='string'||!UUID.test(input.requestId)||
        (Object.hasOwn(input,'expectedPrice')&&![LEGACY_PRICE,PRICE].includes(input.expectedPrice))||
        (Object.hasOwn(input,'expectedCatalogVersion')&&![1,2,CATALOG_VERSION].includes(input.expectedCatalogVersion))||
        (Object.hasOwn(input,'itemType')&&!['sticker','frame'].includes(input.itemType))))){
    throw new HttpError(400,'送信内容を確認してください。','INVALID_REQUEST');
  }
  return{memberId:input.memberId,name:input.name.trim(),...(action==='draw'?{requestId:input.requestId,...(Object.hasOwn(input,'expectedPrice')?{expectedPrice:input.expectedPrice}:{}),...(Object.hasOwn(input,'expectedCatalogVersion')?{expectedCatalogVersion:input.expectedCatalogVersion}:{}),...(Object.hasOwn(input,'itemType')?{itemType:input.itemType}:{})}:{})};
}
// Only the original four may have historical10k receipts. New catalog items
// always cost100k; this still accepts every authentic mixed-price history.
function validHistoricalSpend(spent,count,legacyCount=count){
  return spent>=count*PRICE-legacyCount*(PRICE-LEGACY_PRICE)&&spent<=count*PRICE&&(spent-count*LEGACY_PRICE)%(PRICE-LEGACY_PRICE)===0;
}
function validateQuantities(owned,quantities,catalog){
  if(!Array.isArray(owned)||!Array.isArray(quantities)||owned.length>catalog.length||quantities.length!==owned.length||new Set(owned).size!==owned.length||owned.some(id=>!catalog.includes(id)))return null;
  const map=new Map();let total=0;
  for(const row of quantities){
    if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==2||!Object.hasOwn(row,'id')||!Object.hasOwn(row,'quantity')||!owned.includes(row.id)||map.has(row.id)||!Number.isSafeInteger(row.quantity)||row.quantity<1||row.quantity>100000000)return null;
    map.set(row.id,row.quantity);total+=row.quantity;
  }
  return {total,rows:catalog.filter(id=>map.has(id)).map(id=>({id,quantity:map.get(id)})),ids:catalog.filter(id=>map.has(id)),map};
}
function validateModernWallet(value,{requestId,itemType}={}){
  const invalid=()=>new HttpError(503,'保有金額を確認できませんでした。再試行してください。','SHOP_UNAVAILABLE');
  const points=n=>Number.isSafeInteger(n)&&n>=0&&n<=MAX_POINTS&&n%100===0;
  const mapSpent=Object.hasOwn(value,'mapSpent')?value.mapSpent:0;
  if(!points(mapSpent)||mapSpent>value.spent)throw invalid();
  const stickers=validateQuantities(value.ownedStickers,value.stickerQuantities,STICKERS),frames=validateQuantities(value.ownedFrames,value.frameQuantities,FRAMES);
  if(!['balance','totalIncome','spent'].every(key=>points(value[key]))||value.balance+value.spent!==value.totalIncome||value.price!==PRICE||value.catalogSize!==17||value.frameCatalogSize!==33||value.duplicatesAllowed!==true||
      !Number.isSafeInteger(value.drawCount)||value.drawCount<0||value.drawCount>100000000||!Number.isSafeInteger(value.legacyDiscountedDraws)||value.legacyDiscountedDraws<0||value.legacyDiscountedDraws>4||
      !stickers||!frames||stickers.total+frames.total!==value.drawCount||value.legacyDiscountedDraws>LEGACY_STICKERS.reduce((sum,id)=>sum+(stickers?.map.get(id)||0),0)||
      value.spent!==value.drawCount*PRICE-value.legacyDiscountedDraws*(PRICE-LEGACY_PRICE)+mapSpent||
      !value.frameOdds||typeof value.frameOdds!=='object'||Array.isArray(value.frameOdds)||Object.keys(value.frameOdds).length!==4||!Object.entries(FRAME_ODDS).every(([key,n])=>value.frameOdds[key]===n))throw invalid();
  const result={balance:value.balance,totalIncome:value.totalIncome,spent:value.spent,price:PRICE,catalogVersion:CATALOG_VERSION,catalogSize:17,frameCatalogSize:33,duplicatesAllowed:true,ownedStickers:stickers.ids,ownedFrames:frames.ids,stickerQuantities:stickers.rows,frameQuantities:frames.rows,drawCount:value.drawCount,legacyDiscountedDraws:value.legacyDiscountedDraws,frameOdds:{...FRAME_ODDS}};
  if(Object.hasOwn(value,'mapSpent'))result.mapSpent=mapSpent;
  if(requestId!==undefined){
    const pool=itemType||'sticker',ids=pool==='sticker'?STICKERS:FRAMES,owned=pool==='sticker'?stickers:frames;
    if(typeof requestId!=='string'||!UUID.test(requestId)||typeof value.requestId!=='string'||value.requestId.toLowerCase()!==requestId.toLowerCase()||value.itemType!==pool||!ids.includes(value.itemId)||value[pool==='sticker'?'stickerId':'frameId']!==value.itemId||
      !owned.map.has(value.itemId)||value.quantity!==owned.map.get(value.itemId)||![LEGACY_PRICE,PRICE].includes(value.cost)||value.drawCount<1||value.spent<value.cost||
      (value.cost===LEGACY_PRICE&&(pool!=='sticker'||!LEGACY_STICKERS.includes(value.itemId)||value.legacyDiscountedDraws<1))||
      (pool==='frame'&&(value.rarity!==FRAME_RARITY[value.itemId[0]]||Object.hasOwn(value,'stickerId')))||(pool==='sticker'&&Object.hasOwn(value,'frameId')))throw invalid();
    Object.assign(result,{requestId:requestId.toLowerCase(),itemType:pool,itemId:value.itemId,[pool==='sticker'?'stickerId':'frameId']:value.itemId,quantity:value.quantity,cost:value.cost,...(pool==='frame'?{rarity:value.rarity}:{})});
  }
  return result;
}
function validateWallet(value,{requestId,itemType}={}){
  if(value?.catalogVersion===CATALOG_VERSION)return validateModernWallet(value,{requestId,itemType});
  const hasVersion=!!value&&Object.hasOwn(value,'catalogVersion'),hasSize=!!value&&Object.hasOwn(value,'catalogSize');
  const catalogVersion=hasVersion?value.catalogVersion:1,catalogSize=hasSize?value.catalogSize:LEGACY_STICKERS.length;
  const catalog=catalogVersion===1?LEGACY_STICKERS:STICKERS;
  const legacyCount=ids=>ids.filter(id=>LEGACY_STICKERS.includes(id)).length;
  const points=key=>Number.isSafeInteger(value?.[key])&&value[key]>=0&&value[key]<=MAX_POINTS&&value[key]%100===0;
  if(!value||typeof value!=='object'||Array.isArray(value)||!['balance','totalIncome','spent'].every(points)||
      value.balance+value.spent!==value.totalIncome||![LEGACY_PRICE,PRICE].includes(value.price)||
      hasVersion!==hasSize||!((catalogVersion===1&&catalogSize===4)||(catalogVersion===2&&catalogSize===STICKERS.length))||
      !Array.isArray(value.ownedStickers)||value.ownedStickers.length>catalogSize||
      value.ownedStickers.some(id=>!catalog.includes(id))||new Set(value.ownedStickers).size!==value.ownedStickers.length||
      !validHistoricalSpend(value.spent,value.ownedStickers.length,legacyCount(value.ownedStickers))||
      (requestId&&(itemType==='frame'||value.requestId?.toLowerCase()!==requestId.toLowerCase()||!STICKERS.includes(value.stickerId)||!value.ownedStickers.includes(value.stickerId)||
        (!Object.hasOwn(value,'cost')&&value.price!==LEGACY_PRICE)||(Object.hasOwn(value,'cost')&&![LEGACY_PRICE,PRICE].includes(value.cost))||(!LEGACY_STICKERS.includes(value.stickerId)&&(value.cost??LEGACY_PRICE)!==PRICE)||!validHistoricalSpend(value.spent-(value.cost??LEGACY_PRICE),value.ownedStickers.length-1,legacyCount(value.ownedStickers.filter(id=>id!==value.stickerId)))))){
    throw new HttpError(503,'保有金額を確認できませんでした。再試行してください。','SHOP_UNAVAILABLE');
  }
  return{balance:value.balance,totalIncome:value.totalIncome,spent:value.spent,price:value.price,catalogVersion,catalogSize,
    ownedStickers:STICKERS.filter(id=>value.ownedStickers.includes(id)),
    ...(requestId?{requestId:value.requestId,stickerId:value.stickerId,cost:value.cost??LEGACY_PRICE}:{})};
}
async function wallet(member){
  const input=parseInput('wallet',{memberId:member?.id,name:member?.name});
  await require('./calculus.cjs').refreshMembers([input.memberId]);
  return validateWallet(await store.shopRpc('wallet',input));
}
async function perform(action,input){
  const parsed=parseInput(action,input);
  await require('./calculus.cjs').refreshMembers([parsed.memberId]);
  // Historical acknowledgements remain compatible with old DB versions.
  // New purchases require an explicit price, catalog and pool acknowledgment.
  const forwarded={...parsed};if(forwarded.expectedPrice===LEGACY_PRICE)delete forwarded.expectedPrice;
  // A version1 acknowledgement remains compatible before catalog activation;
  // the new DB rejects its omission before committing any new-item purchase.
  if(forwarded.expectedCatalogVersion===1)delete forwarded.expectedCatalogVersion;
  return validateWallet(await store.shopRpc(action,forwarded),action==='draw'?{requestId:parsed.requestId,itemType:parsed.itemType||'sticker'}:{});
}
function guestWallet(){return{balance:0,totalIncome:0,spent:0,ownedStickers:[],ownedFrames:[],stickerQuantities:[],frameQuantities:[],drawCount:0,legacyDiscountedDraws:0,price:PRICE,catalogVersion:CATALOG_VERSION,catalogSize:STICKERS.length,frameCatalogSize:FRAMES.length,duplicatesAllowed:true,frameOdds:{...FRAME_ODDS}};}
module.exports={authorize,parseInput,validateWallet,wallet,perform,guestWallet,STICKERS,LEGACY_STICKERS,FRAMES,FRAME_ODDS,CATALOG_VERSION,PRICE,LEGACY_PRICE,validHistoricalSpend};
