'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const shop=require('../server/shop.cjs');
const file=path.join(__dirname,'../supabase/migrations/20261115192500_target_frame_epic100k_legend1m_income_payout.sql');
test('one-time migration preserves existing ledgers, separates future income credits from refunds',()=>{
 const sql=fs.readFileSync(file,'utf8');
 for(const marker of [
  'SELECT pg_advisory_xact_lock(991101)',
  'CREATE TEMP TABLE _frame_finance_before',
  'CREATE TEMP TABLE _frame_profiles_before',
  'ADD COLUMN credit_mode text NOT NULL DEFAULT',
  "'spent_refund'","'income_bonus'",
  "WHEN 'epic' THEN 100000","WHEN 'legendary' THEN 1000000",
  '1000000))','target_private.receipt_spend_rebate_amount',
  'target_private.wallet_finance_projection','target_private.wallet_snapshot',
  'target_private.guard_duplicate_rebate_insert','target_private.guard_item_sale_insert',
  'public.target_shop_rpc','public.target_sell_rpc',
  'UPDATE target_private.profiles SET',
  "'income_bonus'","'spent_refund'",
  'total_points=total_points+CASE WHEN duplicate_draw',
  "spent_points=spent_points-CASE WHEN pool_kind='sticker'",
  "REVOKE ALL ON FUNCTION","NOTIFY pgrst",
  "Existing user balance changed unexpectedly",
  "Existing financial projection changed unexpectedly"
 ])assert(sql.includes(marker),marker);
 assert(!/\b(?:TRUNCATE|DELETE FROM target_private\.(?:item_sales|duplicate_rebates|profiles)|DROP TABLE target_private)\b/i.test(sql));
 assert(sql.includes('has_function_privilege'), 'private-only ledger helpers');
 assert(sql.includes('receipt_spend_rebate_amount'), 'do not count bonus as drawing refund');
 assert(!sql.includes('spent_points=spent_points-1000000'), 'never over-refund a 100k drawing');
});
test('new frame awards are derived from catalog, not client-selected amounts',()=>{
 const cases={c01:1000,r11:10000,e06:100000,l08:1000000};
 for(const [id,amount] of Object.entries(cases)){
  assert.equal(shop.payoutFor('frame',id),amount,id);
  assert(shop.validPayout(amount,'frame',id));
  assert(!shop.validPayout(999999,'frame',id));
 }
 assert(shop.validPayout(10000,'frame','e06'),'old epic sale replay');
 assert(shop.validPayout(100000,'frame','l08'),'old legendary sale replay');
 assert.equal(shop.payoutFor('sticker','photo-boss'),10000);
 assert(!shop.validPayout(1000000,'sticker','photo-boss'));
 assert.equal(shop.payoutFor('frame','invalid'),null);
});
