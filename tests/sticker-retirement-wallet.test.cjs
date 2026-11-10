'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const shop=require('../server/shop.cjs');
// One discounted legacy stamp, two paid stamp duplicates and two frame copies.
// The refund includes all prior write-offs plus only the remaining stamp cost.
const retired=()=>({...shop.guestWallet(),totalIncome:1000000,balance:800000,spent:200000,
  drawCount:5,legacyDiscountedDraws:1,voidedDrawCount:3,refundedSpend:210000,
  ownedFrames:['c01'],frameQuantities:[{id:'c01',quantity:2}],walletRevision:14});
test('retirement preserves frame ownership and historical discounted cost while refunding stamp spending',()=>{
  const value=retired();assert.deepEqual(shop.validateWallet(value),value);
  assert.equal(value.balance+value.spent,value.totalIncome);
  assert.equal(value.spent+value.refundedSpend,410000);
  assert.equal(shop.validateWallet(shop.guestWallet()).stickersRetired,true);
});
test('retired stamps cannot reappear through malformed inventory, counts or refund proofs',()=>{
  for(const change of [{catalogSize:17},{stickersRetired:false},{stickersRetired:undefined},
    {ownedStickers:['youth'],stickerQuantities:[{id:'youth',quantity:1}]},
    {voidedDrawCount:2},{legacyDiscountedDraws:0},{refundedSpend:200000},
    {refundedSpend:220000},{drawCount:4}]){
    assert.throws(()=>shop.validateWallet({...retired(),...change}),error=>error.status===503);
  }
});
test('old stamp receipt acknowledgements remain voided with zero ownership and their original costs',()=>{
  for(const [stickerId,cost]of[['youth',10000],['goodnight',100000]]){
    const requestId=crypto.randomUUID(),value={...retired(),requestId,itemType:'sticker',itemId:stickerId,
      stickerId,cost,quantity:0,receiptVoided:true};
    assert.deepEqual(shop.validateWallet(value,{requestId,itemType:'sticker'}),value);
    for(const change of [{receiptVoided:false},{receiptVoided:undefined},{quantity:1},{cost:100}])
      assert.throws(()=>shop.validateWallet({...value,...change},{requestId,itemType:'sticker'}),error=>error.status===503);
  }
});
test('a new frame draw retains the stamp refund proof and accepts the new catalog acknowledgement',()=>{
  const requestId=crypto.randomUUID(),value={...retired(),drawCount:6,spent:300000,balance:700000,
    frameQuantities:[{id:'c01',quantity:3}],requestId,itemType:'frame',itemId:'c01',frameId:'c01',
    rarity:'common',cost:100000,quantity:3};
  assert.deepEqual(shop.validateWallet(value,{requestId,itemType:'frame'}),value);
  assert.equal(shop.parseInput('draw',{memberId:crypto.randomUUID(),name:'検証',requestId,
    expectedPrice:100000,expectedCatalogVersion:4,itemType:'frame'}).expectedCatalogVersion,4);
});
