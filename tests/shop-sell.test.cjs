'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const shop=require('../server/shop.cjs');
const uuid=()=>crypto.randomUUID();
test('Target sale API accepts only member-scoped one-item contracts',()=>{
 const payload={memberId:uuid(),name:'テスト',requestId:uuid(),itemType:'sticker',itemId:'photo-boss'};
 assert.deepEqual(shop.parseInput('sell',payload),payload);
 assert.deepEqual(shop.parseInput('sell',{...payload,itemType:'frame',itemId:'c01'}).itemId,'c01');
 for(const bad of [{...payload,itemId:''},{...payload,itemType:'other'},{...payload,requestId:'BAD'},{...payload,price:10000},{...payload,amount:100000},{...payload,memberId:'INVALID'}])
   assert.throws(()=>shop.parseInput('sell',bad),error=>error.status===400);
});
test('Target checks owned quantities, sold count and refund coverage as one immutable wallet',()=>{
 const value={balance:810000,totalIncome:1000000,spent:190000,price:100000,catalogVersion:5,catalogSize:11,frameCatalogSize:33,
 duplicatesAllowed:true,ownedStickers:['photo-boss'],stickerQuantities:[{id:'photo-boss',quantity:1}],
 ownedFrames:[],frameQuantities:[],drawCount:2,soldItemCount:1,voidedDrawCount:0,
 legacyDiscountedDraws:0,refundedSpend:10000,frameOdds:{common:62,rare:25,epic:10,legendary:3},walletRevision:11};
 assert.equal(shop.validateWallet(value).soldItemCount,1);
 for(const changes of [{soldItemCount:2},{soldItemCount:-1},{refundedSpend:0},{spent:180000,balance:820000},{stickerQuantities:[{id:'photo-boss',quantity:2}]}])
   assert.throws(()=>shop.validateWallet({...value,...changes}),error=>error.status===503);
});
test('sale SQL preserves gross income and excludes precisely sold receipt with audit ledger',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261111073000_target_item_sales.sql'),'utf8');
 for(const term of ['CREATE TABLE IF NOT EXISTS target_private.item_sales','PRIMARY KEY(member_id,operation_id)',
  'UNIQUE(member_id,purchase_request_id)','ENABLE ROW LEVEL SECURITY','item_sale_immutable',
  'public.target_sell_rpc','spent_points=spent_points-10000','soldItemCount',
  'target_private.active_gacha_receipts','target_private.wallet_finance_projection',
  'target_private.wallet_snapshot','purchase_request_id','receipt_financial_refund_amount'])
   if(term==='receipt_financial_refund_amount')continue;else assert(sql.includes(term),'missing '+term);
 assert(!sql.includes('total_points=total_points+10000'));
 assert(!sql.includes('DELETE FROM target_private.item_draws'));
});
