'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const shop=require('../server/shop.cjs');
function duplicateWallet(){
  return {...shop.guestWallet(),totalIncome:1000000,spent:190000,balance:810000,
    drawCount:2,legacyDiscountedDraws:0,refundedSpend:10000,
    ownedStickers:['photo-boss'],stickerQuantities:[{id:'photo-boss',quantity:2}],
    walletRevision:10};
}
test('duplicate gacha retains both copies and increases spend refunds, not income',()=>{
  const wallet=duplicateWallet();
  assert.deepEqual(shop.validateWallet(wallet),wallet);
  const requestId=crypto.randomUUID();
  const receipt={...wallet,requestId,itemType:'sticker',itemId:'photo-boss',
    stickerId:'photo-boss',quantity:2,cost:100000,duplicateRefund:10000};
  assert.deepEqual(shop.validateWallet(receipt,{requestId,itemType:'sticker'}),receipt);
  for(const amount of [9999,0,true,'10000',null,100000]){
    assert.throws(()=>shop.validateWallet({...receipt,duplicateRefund:amount},{requestId,itemType:'sticker'}),error=>error.status===503);
  }
});
test('frame duplicates can receive same rebate, original purchase identity is immutable',()=>{
  const value={...shop.guestWallet(),totalIncome:1000000,spent:190000,balance:810000,
    drawCount:2,refundedSpend:10000,ownedFrames:['c01'],frameQuantities:[{id:'c01',quantity:2}],walletRevision:2};
  const requestId=crypto.randomUUID();
  const receipt={...value,requestId,itemType:'frame',itemId:'c01',frameId:'c01',
    rarity:'common',quantity:2,cost:100000,duplicateRefund:10000};
  assert.deepEqual(shop.validateWallet(receipt,{requestId,itemType:'frame'}),receipt);
  assert.throws(()=>shop.validateWallet({...receipt,frameId:'c02'},{requestId,itemType:'frame'}),error=>error.status===503);
});
test('rebate SQL always has one immutable credit per purchase, and accounts for old refunds',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261110233000_duplicate_gacha_rebate.sql'),'utf8');
  for(const marker of ['duplicate_rebates','PRIMARY KEY(member_id,request_id)',
    'ALTER TABLE target_private.duplicate_rebates ENABLE ROW LEVEL SECURITY',
    'CREATE TRIGGER duplicate_rebate_immutable',
    'receipt_duplicate_rebate_amount','ON CONFLICT(member_id,request_id) DO NOTHING',
    'Duplicate rebates must reconcile with permanent wallet histories',
    'new_bytes:=pg_column_size','CASE WHEN duplicate_draw THEN 256 ELSE 0 END']){
    assert(sql.includes(marker),marker);
  }
  assert(!/DROP TABLE|TRUNCATE|DELETE FROM target_private\.profiles/i.test(sql));
});
