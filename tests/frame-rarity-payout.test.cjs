'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const shop=require('../server/shop.cjs');
test('staged financial migration safeguards immutable prior 10k records and changes only future payouts',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../docs/FRAME_RARITY_PAYOUT_MIGRATION_STAGED.sql'),'utf8');
 for(const token of [
  'SELECT pg_advisory_xact_lock(991101)',
  'target_private.item_payout_amount',
  "WHEN 'common' THEN 1000","WHEN 'rare' THEN 10000","WHEN 'epic' THEN 10000","WHEN 'legendary' THEN 100000",
  'duplicate_rebates_amount_check','item_sales_amount_check',
  'guard_duplicate_rebate_insert','guard_item_sale_insert',
  'public.target_shop_rpc','public.target_sell_rpc',
  'target_private.receipt_duplicate_rebate_amount(member_uuid,request_uuid)',
  "'soldAmount'',saved.amount",
  'd.cost::bigint-target_private.receipt_financial_refund_amount(d.member_id,d.request_id)',
  '>=sale_amount', 'NOTIFY pgrst'
 ])assert(sql.includes(token),'Required safety control '+token);
 assert(!/DELETE FROM target_private\.(?:item_sales|duplicate_rebates|profiles)|TRUNCATE|DROP TABLE/i.test(sql));
 assert(sql.includes("item_type='sticker' AND amount=10000"),'sticker payout unchanged');
 assert(sql.includes("'frame' AND amount IN(1000,10000,100000)"));
});
test('payouts are authoritative, unaffected by caller amount or frame artwork and limited to catalog IDs',()=>{
 for(const [id,expected] of Object.entries({c01:1000,c15:1000,r01:10000,r15:10000,e01:10000,e10:10000,l01:100000,l08:100000})){
  assert.equal(shop.payoutFor('frame',id),expected);
  assert(shop.validPayout(expected,'frame',id));
 }
 assert.equal(shop.payoutFor('frame','../l08'),null);
 assert.equal(shop.payoutFor('sticker','photo-boss'),10000);
 assert(!shop.validPayout(100000,'sticker','photo-boss'));
});
