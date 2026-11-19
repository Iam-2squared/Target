-- Target-only rarity payout migration. Historic sale/duplicate receipts remain immutable.
-- Prices for NEW frame transactions: common 1k, rare 10k, epic 10k, legendary 100k.
-- Sticker amount stays 10k. The full-size source of truth is target_private.frame_catalog.
SELECT pg_advisory_xact_lock(991101);
DO $guard$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.guard_duplicate_rebate_insert()'::regprocedure) <> '3847cdd90a3ba780b5c686cf820a11b7'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.guard_item_sale_insert()'::regprocedure) <> 'a9f5d7aebf1a878e3d37c67c7be30480'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_shop_rpc(text,text,jsonb)'::regprocedure) <> 'c277ded280d0b88cadd61f4509d760b3'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_sell_rpc(text,text,jsonb)'::regprocedure) <> 'ed37b565d65f9b1373fc5af3874f4f28'
 THEN RAISE EXCEPTION 'Financial SQL definitions changed since review'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION target_private.item_payout_amount(p_item_type text,p_item_id text)
RETURNS bigint LANGUAGE sql STABLE SET search_path TO 'pg_catalog' AS $payout$
 SELECT CASE WHEN p_item_type='sticker' THEN
   (SELECT 10000::bigint WHERE EXISTS(SELECT 1 FROM target_private.sticker_catalog c WHERE c.id=p_item_id AND c.generation=5))
 WHEN p_item_type='frame' THEN
   (SELECT CASE c.rarity WHEN 'common' THEN 1000::bigint WHEN 'rare' THEN 10000::bigint
     WHEN 'epic' THEN 10000::bigint WHEN 'legendary' THEN 100000::bigint ELSE NULL END
      FROM target_private.frame_catalog c WHERE c.id=p_item_id)
 ELSE NULL END;
$payout$;
REVOKE ALL ON FUNCTION target_private.item_payout_amount(text,text) FROM PUBLIC,anon,authenticated;
-- Allow preexisting 10k credit receipts; enforce new prices through private insertion triggers.
ALTER TABLE target_private.duplicate_rebates DROP CONSTRAINT duplicate_rebates_amount_check;
ALTER TABLE target_private.duplicate_rebates ADD CONSTRAINT duplicate_rebates_amount_check
 CHECK ((item_type='sticker' AND amount=10000) OR (item_type='frame' AND amount IN(1000,10000,100000)));
ALTER TABLE target_private.item_sales DROP CONSTRAINT item_sales_amount_check;
ALTER TABLE target_private.item_sales ADD CONSTRAINT item_sales_amount_check
 CHECK ((item_type='sticker' AND amount=10000) OR (item_type='frame' AND amount IN(1000,10000,100000)));
DO $patch$
DECLARE definition text; oid regprocedure;
BEGIN
 oid:='target_private.guard_duplicate_rebate_insert()'::regprocedure;
 SELECT pg_get_functiondef(oid) INTO definition;
 definition:=replace(definition,'NEW.amount<>10000',
   'NEW.amount IS DISTINCT FROM target_private.item_payout_amount(NEW.item_type,NEW.item_id)');
 definition:=replace(definition,
   'r.cost-target_private.receipt_financial_refund_amount(NEW.member_id,NEW.request_id)<10000',
   'r.cost-target_private.receipt_financial_refund_amount(NEW.member_id,NEW.request_id)<NEW.amount');
 IF position('NEW.amount IS DISTINCT FROM target_private.item_payout_amount' IN definition)=0
 OR position('r.cost-target_private.receipt_financial_refund_amount(NEW.member_id,NEW.request_id)<NEW.amount' IN definition)=0
 THEN RAISE EXCEPTION 'Guard rebate transform failed'; END IF;
 EXECUTE definition;

 oid:='target_private.guard_item_sale_insert()'::regprocedure;
 SELECT pg_get_functiondef(oid) INTO definition;
 definition:=replace(definition,'OR NEW.amount<>10000',
   'OR NEW.amount IS DISTINCT FROM target_private.item_payout_amount(NEW.item_type,NEW.item_id)');
 definition:=replace(definition,'OR EXISTS(SELECT 1 FROM target_private.item_sales x',
   'OR d.cost::bigint-target_private.receipt_financial_refund_amount(NEW.member_id,NEW.purchase_request_id)-target_private.receipt_duplicate_rebate_amount(NEW.member_id,NEW.purchase_request_id)<NEW.amount
   OR EXISTS(SELECT 1 FROM target_private.item_sales x');
 IF position('NEW.amount IS DISTINCT FROM target_private.item_payout_amount' IN definition)=0
 OR position('receipt_duplicate_rebate_amount(NEW.member_id,NEW.purchase_request_id)<NEW.amount' IN definition)=0
 THEN RAISE EXCEPTION 'Guard sale transform failed'; END IF;
 EXECUTE definition;

 oid:='public.target_shop_rpc(text,text,jsonb)'::regprocedure;
 SELECT pg_get_functiondef(oid) INTO definition;
 definition:=replace(definition,'''duplicateRefund'',10000',
   '''duplicateRefund'',target_private.receipt_duplicate_rebate_amount(member_uuid,request_uuid)');
 definition:=replace(definition,
   'INSERT INTO target_private.duplicate_rebates(member_id,request_id,item_type,item_id,source)',
   'INSERT INTO target_private.duplicate_rebates(member_id,request_id,item_type,item_id,source,amount)');
 definition:=replace(definition,
   'VALUES(member_uuid,request_uuid,pool_kind,chosen_id,''draw'');',
   'VALUES(member_uuid,request_uuid,pool_kind,chosen_id,''draw'',target_private.item_payout_amount(pool_kind,chosen_id));');
 definition:=replace(definition,'THEN 10000 ELSE 0 END WHERE member_id=member_uuid',
   'THEN target_private.item_payout_amount(pool_kind,chosen_id) ELSE 0 END WHERE member_id=member_uuid');
 IF position('THEN target_private.item_payout_amount(pool_kind,chosen_id) ELSE 0 END' IN definition)=0
 OR position('source,amount)' IN definition)=0
 OR position('''duplicateRefund'',10000' IN definition)>0
 THEN RAISE EXCEPTION 'Gacha RPC transform failed'; END IF;
 EXECUTE definition;

 oid:='public.target_sell_rpc(text,text,jsonb)'::regprocedure;
 SELECT pg_get_functiondef(oid) INTO definition;
 definition:=replace(definition,'chosen record; waits integer; bytes_needed integer; refunded bigint; total_purchase bigint;',
   'chosen record; waits integer; bytes_needed integer; refunded bigint; total_purchase bigint; sale_amount bigint;');
 definition:=regexp_replace(definition,'''soldAmount'',10000','''soldAmount'',saved.amount');
 definition:=regexp_replace(definition,'''soldAmount'',10000','''soldAmount'',sale_amount');
 definition:=replace(definition,
   'SELECT request_id,item_type,item_id,drawn_at INTO chosen FROM target_private.active_gacha_receipts(member_uuid) d
   WHERE d.item_type=pool_kind AND d.item_id=chosen_id ORDER BY d.drawn_at,d.request_id LIMIT 1;',
   'sale_amount:=target_private.item_payout_amount(pool_kind,chosen_id);
 IF sale_amount IS NULL THEN RETURN target_private.error_result(409,''SALE_NOT_AVAILABLE'',''売却額を確認できません。''); END IF;
 SELECT request_id,item_type,item_id,drawn_at INTO chosen FROM target_private.active_gacha_receipts(member_uuid) d
   WHERE d.item_type=pool_kind AND d.item_id=chosen_id
     AND target_private.receipt_financial_refund_amount(d.member_id,d.request_id) IS NOT NULL
     AND d.cost::bigint-target_private.receipt_financial_refund_amount(d.member_id,d.request_id)
       -target_private.receipt_duplicate_rebate_amount(d.member_id,d.request_id)>=sale_amount
   ORDER BY d.drawn_at,d.request_id LIMIT 1;');
 definition:=replace(definition,
   'IF NOT FOUND THEN RETURN target_private.error_result(409,''ITEM_NOT_OWNED'',''保有していないアイテムです。''); END IF;',
   'IF NOT FOUND THEN RETURN target_private.error_result(409,''SALE_NOT_AVAILABLE'',''保有品に返還可能な購入額がありません。''); END IF;');
 definition:=replace(definition,'member_row.spent_points<10000','member_row.spent_points<sale_amount');
 definition:=replace(definition,'refunded+10000>total_purchase','refunded+sale_amount>total_purchase');
 definition:=replace(definition,
   'VALUES(member_uuid,sale_uuid,chosen.request_id,pool_kind,chosen_id,10000);',
   'VALUES(member_uuid,sale_uuid,chosen.request_id,pool_kind,chosen_id,sale_amount);');
 definition:=replace(definition,'spent_points=spent_points-10000 WHERE member_id=member_uuid',
   'spent_points=spent_points-sale_amount WHERE member_id=member_uuid');
 IF position('''soldAmount'',10000' IN definition)>0
 OR position('''soldAmount'',saved.amount' IN definition)=0
 OR position('''soldAmount'',sale_amount' IN definition)=0
 OR position('spent_points=spent_points-sale_amount' IN definition)=0
 OR position('>=sale_amount' IN definition)=0
 THEN RAISE EXCEPTION 'Sale RPC transform failed'; END IF;
 EXECUTE definition;
END $patch$;
DO $verify$
BEGIN
 IF target_private.item_payout_amount('frame','c01')<>1000
 OR target_private.item_payout_amount('frame','r11')<>10000
 OR target_private.item_payout_amount('frame','e06')<>10000
 OR target_private.item_payout_amount('frame','l08')<>100000
 OR target_private.item_payout_amount('sticker','photo-boss')<>10000
 OR target_private.item_payout_amount('frame','unknown') IS NOT NULL
 THEN RAISE EXCEPTION 'Target payout catalog failed verification'; END IF;
 IF has_function_privilege('anon','target_private.item_payout_amount(text,text)','EXECUTE')
 OR has_function_privilege('authenticated','target_private.item_payout_amount(text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'Rarity payout helper must remain private'; END IF;
END $verify$;
NOTIFY pgrst,'reload schema';
