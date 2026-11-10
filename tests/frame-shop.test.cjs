'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const shop=require('../server/shop.cjs');
const id=()=>crypto.randomUUID();
const historicalGuest=()=>{const value=shop.guestWallet();delete value.stickersRetired;return {...value,catalogVersion:3,catalogSize:17};};
const wallet=()=>({...historicalGuest(),totalIncome:2000000,balance:1670000,spent:330000,ownedStickers:['youth','sunglasses','night'],stickerQuantities:[{id:'youth',quantity:2},{id:'sunglasses',quantity:1},{id:'night',quantity:1}],ownedFrames:['c01','l03'],frameQuantities:[{id:'c01',quantity:1},{id:'l03',quantity:1}],drawCount:6,legacyDiscountedDraws:3});
test('v3 counts every paid duplicate while preserving historical discounted receipts',()=>{
  const value=wallet();assert.deepEqual(shop.validateWallet(value),value);
  for(const change of [{spent:320000,balance:1680000},{drawCount:5},{legacyDiscountedDraws:4},{ownedFrames:['c01']},{ownedStickers:['youth','sunglasses','night','love']},{stickerQuantities:[{id:'youth',quantity:1},{id:'sunglasses',quantity:1},{id:'night',quantity:1}]},{frameQuantities:[{id:'c01',quantity:1},{id:'c01',quantity:1}]},{duplicatesAllowed:false},{frameOdds:{common:61,rare:25,epic:10,legendary:4}},{frameCatalogSize:34}])assert.throws(()=>shop.validateWallet({...value,...change}),error=>error.status===503);
});
test('v3 draw validation binds pool, result, current quantity, rarity and immutable cost',()=>{
  const requestId=id(),frame={...wallet(),requestId,itemType:'frame',itemId:'l03',frameId:'l03',rarity:'legendary',quantity:1,cost:100000};
  assert.deepEqual(shop.validateWallet(frame,{requestId,itemType:'frame'}),frame);
  for(const change of [{itemType:'sticker'},{frameId:'l02'},{itemId:'l02'},{rarity:'common'},{quantity:2},{cost:10000},{stickerId:'youth'},{requestId:id()}])assert.throws(()=>shop.validateWallet({...frame,...change},{requestId,itemType:'frame'}),error=>error.status===503);
  const old={...wallet(),requestId,itemType:'sticker',itemId:'youth',stickerId:'youth',quantity:2,cost:10000};assert.deepEqual(shop.validateWallet(old,{requestId}),old);
  assert.throws(()=>shop.validateWallet(old,{requestId,itemType:'frame'}),error=>error.status===503);
});
test('two explicit pools accept no client-selected winner, rarity, probability or balance',()=>{
  const body={memberId:id(),name:'表示名',requestId:id(),expectedPrice:100000,expectedCatalogVersion:3};
  for(const itemType of ['sticker','frame'])assert.equal(shop.parseInput('draw',{...body,itemType}).itemType,itemType);
  for(const extra of [{itemType:'frames'},{itemType:null},{itemType:'frame',frameId:'l01'},{itemType:'frame',rarity:'legendary'},{itemType:'frame',frameOdds:{legendary:100}},{itemType:'frame',balance:10000000}])assert.throws(()=>shop.parseInput('draw',{...body,...extra}),error=>error.status===400);
});
test('code-first rollout reads authentic v1 and v2 responses without claiming v3 ownership',()=>{
  const v1={balance:90000,totalIncome:100000,spent:10000,price:100000,ownedStickers:['youth']};
  assert.deepEqual(shop.validateWallet(v1),{...v1,catalogVersion:1,catalogSize:4});
  const v2={balance:0,totalIncome:100000,spent:100000,price:100000,catalogVersion:2,catalogSize:17,ownedStickers:['goodnight']};
  assert.deepEqual(shop.validateWallet(v2),v2);assert.equal(shop.validateWallet(v2).ownedFrames,undefined);
  assert.throws(()=>shop.validateWallet({...v2,requestId:'x',stickerId:'goodnight',cost:100000},{requestId:'x',itemType:'frame'}),error=>error.status===503);
});
test('v3 restoration refunds spending while retaining every item and replaying its original receipt',()=>{
  const value={...wallet(),balance:2000000,spent:0,refundedSpend:330000,walletRevision:12};
  assert.deepEqual(shop.validateWallet(value),value);
  const mapped={...value,mapSpent:100,spent:100,balance:1999900};assert.deepEqual(shop.validateWallet(mapped),mapped);
  const zero={...wallet(),refundedSpend:0};assert.deepEqual(shop.validateWallet(zero),zero);
  for(const refundedSpend of [undefined,null,-100,1,10,50,329900,330100,10000000000100,Infinity,'330000'])assert.throws(()=>shop.validateWallet({...value,refundedSpend}),error=>error.status===503);
  assert.throws(()=>shop.validateWallet({...value,refundedSpend:330100,mapSpent:100}),error=>error.status===503);
  const requestId=id(),replay={...value,requestId,itemType:'frame',itemId:'l03',frameId:'l03',rarity:'legendary',quantity:1,cost:100000};
  assert.deepEqual(shop.validateWallet(replay,{requestId,itemType:'frame'}),replay);
  for(const change of [{quantity:2},{cost:10000},{frameId:'l02'},{rarity:'common'}])assert.throws(()=>shop.validateWallet({...replay,...change},{requestId,itemType:'frame'}),error=>error.status===503);
});
test('inventory tombstones retain historical spend proof and acknowledge voided receipts without ownership',()=>{
  const base={...historicalGuest(),balance:100000,totalIncome:100000,spent:0,refundedSpend:200000,drawCount:2,voidedDrawCount:2,walletRevision:20};
  assert.deepEqual(shop.validateWallet(base),base);
  for(const voidedDrawCount of [undefined,null,-1,1,3,1.5,'2',100000001])assert.throws(()=>shop.validateWallet({...base,voidedDrawCount}),error=>error.status===503);
  const zero={...historicalGuest(),voidedDrawCount:0};assert.deepEqual(shop.validateWallet(zero),zero);
  const requestId=id(),voided={...base,requestId,itemType:'frame',itemId:'c01',frameId:'c01',rarity:'common',quantity:0,cost:100000,receiptVoided:true};
  assert.deepEqual(shop.validateWallet(voided,{requestId,itemType:'frame'}),voided);
  for(const patch of [{receiptVoided:false},{receiptVoided:null},{receiptVoided:'true'},{quantity:1},{cost:10000},{frameId:'c02'}])assert.throws(()=>shop.validateWallet({...voided,...patch},{requestId,itemType:'frame'}),error=>error.status===503);
  const nonvoided={...voided};delete nonvoided.receiptVoided;assert.throws(()=>shop.validateWallet(nonvoided,{requestId,itemType:'frame'}),error=>error.status===503);
  const copy={...voided,ownedFrames:['c01'],frameQuantities:[{id:'c01',quantity:1}],voidedDrawCount:1,spent:100000,balance:0,refundedSpend:100000,quantity:1};
  assert.deepEqual(shop.validateWallet(copy,{requestId,itemType:'frame'}),copy);
  const noVoid={...copy,drawCount:1,voidedDrawCount:0,refundedSpend:0};assert.throws(()=>shop.validateWallet(noVoid,{requestId,itemType:'frame'}),error=>error.status===503);
});
