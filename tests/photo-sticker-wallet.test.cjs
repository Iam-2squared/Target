'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const shop=require('../server/shop.cjs');
const wallet=()=>({...shop.guestWallet(),totalIncome:1000000,balance:700000,spent:300000,
  drawCount:6,legacyDiscountedDraws:1,voidedDrawCount:3,refundedSpend:210000,
  ownedStickers:['photo-boss'],stickerQuantities:[{id:'photo-boss',quantity:2}],
  ownedFrames:['c01'],frameQuantities:[{id:'c01',quantity:1}],walletRevision:15});
test('v5 guest and paid duplicates use exactly the new11 photo catalog without reviving refunded stamps',()=>{
  const guest=shop.guestWallet();assert.equal(guest.catalogVersion,5);assert.equal(guest.catalogSize,11);
  assert.equal(shop.ACTIVE_STICKERS.length,11);assert.equal(new Set(shop.ACTIVE_STICKERS).size,11);
  assert.ok(shop.ACTIVE_STICKERS.every(id=>id.startsWith('photo-')&&!shop.STICKERS.includes(id)));
  assert.deepEqual(shop.validateWallet(guest),guest);assert.deepEqual(shop.validateWallet(wallet()),wallet());
  for(const change of [{catalogSize:28},{stickersRetired:false},{stickersRetired:true},
    {ownedStickers:['youth'],stickerQuantities:[{id:'youth',quantity:2}]},{voidedDrawCount:2},
    {refundedSpend:200000},{frameOdds:{common:61,rare:26,epic:10,legendary:3}}])
    assert.throws(()=>shop.validateWallet({...wallet(),...change}),error=>error.status===503);
});
test('new photo receipts require full-price active identity, correct quantity and request',()=>{
  const requestId=crypto.randomUUID(),value={...wallet(),requestId,itemType:'sticker',itemId:'photo-boss',stickerId:'photo-boss',quantity:2,cost:100000};
  assert.deepEqual(shop.validateWallet(value,{requestId}),value);
  for(const patch of [{cost:10000},{quantity:1},{stickerId:'photo-best'},{itemId:'youth',stickerId:'youth'},{requestId:crypto.randomUUID()}])
    assert.throws(()=>shop.validateWallet({...value,...patch},{requestId}),error=>error.status===503);
});
test('old refunded receipt retries remain acknowledged as voided inside a v5 wallet',()=>{
  const requestId=crypto.randomUUID(),value={...wallet(),requestId,itemType:'sticker',itemId:'youth',stickerId:'youth',quantity:0,cost:10000,receiptVoided:true};
  assert.deepEqual(shop.validateWallet(value,{requestId}),value);
  for(const patch of [{quantity:1},{receiptVoided:undefined},{receiptVoided:false}])
    assert.throws(()=>shop.validateWallet({...value,...patch},{requestId}),error=>error.status===503);
  const futureInRetired={...value,catalogVersion:4,catalogSize:0,stickersRetired:true,ownedStickers:[],stickerQuantities:[],drawCount:4,spent:100000,balance:900000,itemId:'photo-boss',stickerId:'photo-boss',cost:100000};
  assert.throws(()=>shop.validateWallet(futureInRetired,{requestId}),error=>error.status===503);
});
test('old acknowledgements stay parseable for replay while v5 accepts no winner or price override',()=>{
  const base={memberId:crypto.randomUUID(),name:'表示名',requestId:crypto.randomUUID(),expectedPrice:100000,itemType:'sticker'};
  for(const expectedCatalogVersion of [1,2,3,4,5])assert.equal(shop.parseInput('draw',{...base,expectedCatalogVersion}).expectedCatalogVersion,expectedCatalogVersion);
  for(const patch of [{expectedCatalogVersion:6},{itemId:'photo-best'},{expectedPrice:1},{odds:100}])
    assert.throws(()=>shop.parseInput('draw',{...base,expectedCatalogVersion:5,...patch}),error=>error.status===400);
});
