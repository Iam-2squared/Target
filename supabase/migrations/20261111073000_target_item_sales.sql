-- Target: sell one owned active item for 10,000 todo.
-- Sales refund spent money, not gross income; immutable and idempotent by operation UUID.
-- Run only in the dedicated Target Supabase project.
SELECT pg_advisory_xact_lock(991101);
CREATE TABLE IF NOT EXISTS target_private.item_sales (
  member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
  operation_id uuid NOT NULL,
  purchase_request_id uuid NOT NULL,
  item_type text NOT NULL CHECK(item_type IN('sticker','frame')),
  item_id text NOT NULL CHECK(length(item_id) BETWEEN 1 AND 80),
  amount bigint NOT NULL DEFAULT 10000 CHECK(amount=10000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
  PRIMARY KEY(member_id,operation_id), UNIQUE(member_id,purchase_request_id)
);
ALTER TABLE target_private.item_sales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON target_private.item_sales FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION target_private.guard_item_sale_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $guard$
DECLARE d record;
BEGIN
 PERFORM pg_advisory_xact_lock(991101);
 SELECT * INTO d FROM target_private.gacha_receipts(NEW.member_id) r WHERE r.request_id=NEW.purchase_request_id;
 IF NOT FOUND OR d.item_type IS DISTINCT FROM NEW.item_type OR d.item_id IS DISTINCT FROM NEW.item_id
   OR NEW.amount<>10000
   OR EXISTS(SELECT 1 FROM target_private.inventory_voids v WHERE v.member_id=NEW.member_id AND v.request_id=NEW.purchase_request_id)
   OR EXISTS(SELECT 1 FROM target_private.item_sales x WHERE x.member_id=NEW.member_id AND x.purchase_request_id=NEW.purchase_request_id)
 THEN RAISE EXCEPTION 'Sale receipt must reference one unsold active purchase' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION target_private.guard_item_sale_insert() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER item_sale_guard BEFORE INSERT ON target_private.item_sales
 FOR EACH ROW EXECUTE FUNCTION target_private.guard_item_sale_insert();
CREATE OR REPLACE FUNCTION target_private.guard_item_sale_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $immutable$
BEGIN RAISE EXCEPTION 'Sale receipts cannot change' USING ERRCODE='42501'; END $immutable$;
REVOKE ALL ON FUNCTION target_private.guard_item_sale_immutable() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER item_sale_immutable BEFORE UPDATE OR DELETE ON target_private.item_sales
 FOR EACH ROW EXECUTE FUNCTION target_private.guard_item_sale_immutable();
CREATE OR REPLACE FUNCTION target_private.active_gacha_receipts(p_member uuid DEFAULT NULL::uuid)
 RETURNS TABLE(member_id uuid, request_id uuid, item_type text, item_id text, cost integer, drawn_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT r.* FROM target_private.gacha_receipts(p_member) r
    WHERE NOT EXISTS(SELECT 1 FROM target_private.inventory_voids v WHERE v.member_id=r.member_id AND v.request_id=r.request_id)
      AND NOT EXISTS(SELECT 1 FROM target_private.item_sales s WHERE s.member_id=r.member_id AND s.purchase_request_id=r.request_id);
$function$;
CREATE OR REPLACE FUNCTION target_private.wallet_snapshot(p_member uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  WITH receipts AS(SELECT * FROM target_private.gacha_receipts(p_member)),
  quantities AS(SELECT item_type,item_id,count(*)::integer quantity FROM target_private.active_gacha_receipts(p_member) GROUP BY item_type,item_id),
  refunds AS(SELECT coalesce((SELECT sum(spent_refund) FROM target_private.wallet_restorations WHERE member_id=p_member),0)
      +coalesce((SELECT sum(additional_refund) FROM target_private.inventory_voids WHERE member_id=p_member),0)
      +coalesce((SELECT sum(amount) FROM target_private.duplicate_rebates WHERE member_id=p_member),0)
      +coalesce((SELECT sum(amount) FROM target_private.item_sales WHERE member_id=p_member),0) amount),
  voids AS(SELECT count(*)::integer amount FROM target_private.inventory_voids WHERE member_id=p_member)
  SELECT jsonb_build_object('balance',p.total_points-p.spent_points,'totalIncome',p.total_points,'spent',p.spent_points,'walletRevision',p.wallet_revision,
    'mapSpent',coalesce((SELECT sum(cost) FROM target_private.map_purchases WHERE member_id=p_member),0)+coalesce((SELECT sum(cost) FROM target_private.territory_orders WHERE member_id=p_member),0),
    'price',100000,'catalogVersion',5,'catalogSize',11,'frameCatalogSize',33,'duplicatesAllowed',true,
    'drawCount',(SELECT count(*)::integer FROM receipts),'soldItemCount',(SELECT count(*)::integer FROM target_private.item_sales WHERE member_id=p_member),'legacyDiscountedDraws',(SELECT count(*)::integer FROM receipts WHERE cost=10000),
    'frameOdds',jsonb_build_object('common',62,'rare',25,'epic',10,'legendary',3),
    'ownedStickers',coalesce((SELECT jsonb_agg(c.id ORDER BY c.ordinal) FROM target_private.sticker_catalog c JOIN quantities q ON q.item_type='sticker' AND q.item_id=c.id AND c.generation=5),'[]'::jsonb),
    'stickerQuantities',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'quantity',q.quantity) ORDER BY c.ordinal) FROM target_private.sticker_catalog c JOIN quantities q ON q.item_type='sticker' AND q.item_id=c.id AND c.generation=5),'[]'::jsonb),
    'ownedFrames',coalesce((SELECT jsonb_agg(c.id ORDER BY c.ordinal) FROM target_private.frame_catalog c JOIN quantities q ON q.item_type='frame' AND q.item_id=c.id),'[]'::jsonb),
    'frameQuantities',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'quantity',q.quantity) ORDER BY c.ordinal) FROM target_private.frame_catalog c JOIN quantities q ON q.item_type='frame' AND q.item_id=c.id),'[]'::jsonb))
    ||CASE WHEN refunds.amount>0 THEN jsonb_build_object('refundedSpend',refunds.amount) ELSE '{}'::jsonb END
    ||CASE WHEN voids.amount>0 THEN jsonb_build_object('voidedDrawCount',voids.amount) ELSE '{}'::jsonb END
  
  FROM target_private.profiles p CROSS JOIN refunds CROSS JOIN voids WHERE p.member_id=p_member;
$function$;
CREATE OR REPLACE FUNCTION target_private.wallet_finance_projection(p_cutoff timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(member_id uuid, total_points bigint, spent_points bigint, calculus_points bigint, birthday_points bigint, casino_net bigint, calculus_forgiven_points bigint, raw_study_points bigint, map_spent bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 WITH study AS(SELECT a.member_id,sum(a.award_points)::bigint amount FROM target_private.answers a
   WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 calculus AS(SELECT a.member_id,sum(a.amount)::bigint amount FROM target_private.calculus_credits a
   WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 voids AS(SELECT a.member_id,sum(a.amount)::bigint amount,sum(a.forgiven_amount)::bigint forgiven
   FROM target_private.calculus_void_receipts a WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 recoveries AS(SELECT a.member_id,sum(a.calculus_delta)::bigint calculus,sum(a.forgiven_delta)::bigint forgiven
   FROM target_private.external_calculus_recovery_deltas(p_cutoff) a GROUP BY a.member_id),
 gifts AS(SELECT a.member_id,sum(a.amount)::bigint amount FROM (
   SELECT member_id,amount,created_at FROM target_private.birthday_receipts
   UNION ALL SELECT member_id,amount,created_at FROM target_private.birthday_upgrades
 ) a WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 games AS(SELECT a.member_id,sum(a.net)::bigint amount FROM (SELECT member_id,net,created_at FROM target_private.casino_rounds UNION ALL SELECT member_id,delta,created_at FROM target_private.two_player_wallet_events) a
   WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 spending AS(SELECT a.member_id,sum(a.cost)::bigint amount,sum(a.cost) FILTER(WHERE a.map_cost)::bigint map_amount FROM(
     SELECT member_id,cost,created_at,false map_cost FROM target_private.sticker_draws
     UNION ALL SELECT member_id,cost,created_at,false FROM target_private.item_draws
     UNION ALL SELECT member_id,cost,created_at,true FROM target_private.map_purchases
     UNION ALL SELECT member_id,cost,created_at,true FROM target_private.territory_orders) a
   WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 corrections AS(SELECT a.member_id,sum((a.component_deltas->>'rawStudyPoints')::bigint)::bigint study,
     sum((a.component_deltas->>'calculusPoints')::bigint)::bigint calculus,
     sum((a.component_deltas->>'birthdayPoints')::bigint)::bigint birthday,
     sum((a.component_deltas->>'casinoNet')::bigint)::bigint casino,
     sum((a.component_deltas->>'calculusForgivenPoints')::bigint)::bigint forgiven,
     sum((a.component_deltas->>'spentPoints')::bigint)::bigint spent
   FROM target_private.wallet_restorations a JOIN target_private.wallet_restoration_events e USING(reset_id)
   WHERE p_cutoff IS NULL OR e.created_at<p_cutoff GROUP BY a.member_id),
 components AS(SELECT p.member_id,coalesce(s.amount,0)+coalesce(r.study,0) study,
     coalesce(c.amount,0)+coalesce(v.amount,0)+coalesce(z.calculus,0)+coalesce(r.calculus,0) calculus,
     coalesce(b.amount,0)+coalesce(r.birthday,0) birthday,coalesce(g.amount,0)+coalesce(r.casino,0) casino,
     coalesce(v.forgiven,0)+coalesce(z.forgiven,0)+coalesce(r.forgiven,0) forgiven,
     coalesce(x.amount,0)+coalesce(r.spent,0)-coalesce((SELECT sum(i.additional_refund) FROM target_private.inventory_voids i WHERE i.member_id=p.member_id AND (p_cutoff IS NULL OR i.created_at<p_cutoff)),0)-coalesce((SELECT sum(b.amount) FROM target_private.duplicate_rebates b WHERE b.member_id=p.member_id AND (p_cutoff IS NULL OR b.credited_at<p_cutoff)),0)
     -coalesce((SELECT sum(a.amount) FROM target_private.item_sales a WHERE a.member_id=p.member_id AND (p_cutoff IS NULL OR a.created_at<p_cutoff)),0) spent,coalesce(x.map_amount,0) map_spent
   FROM target_private.profiles p LEFT JOIN study s USING(member_id) LEFT JOIN calculus c USING(member_id)
     LEFT JOIN voids v USING(member_id) LEFT JOIN recoveries z USING(member_id)
     LEFT JOIN gifts b USING(member_id) LEFT JOIN games g USING(member_id)
     LEFT JOIN spending x USING(member_id) LEFT JOIN corrections r USING(member_id))
 SELECT member_id,study+calculus+birthday+casino+forgiven,spent,calculus,birthday,casino,forgiven,study,map_spent FROM components;
$function$;
CREATE OR REPLACE FUNCTION target_private.validate_inventory_void()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE d record; refunded bigint; refund_event text;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  SELECT * INTO STRICT d FROM target_private.gacha_receipts(NEW.member_id) WHERE request_id=NEW.request_id;
  IF (NEW.item_type,NEW.item_id,NEW.cost,NEW.drawn_at) IS DISTINCT FROM
      (d.item_type,d.item_id,d.cost,d.drawn_at) THEN
    RAISE EXCEPTION 'Inventory tombstone does not match its immutable purchase' USING ERRCODE='23514';
  END IF;
  IF d.cost<>100000 AND NOT(d.item_type='sticker' AND d.cost=10000) THEN
    RAISE EXCEPTION 'Unsupported immutable purchase cost' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.item_sales s WHERE s.member_id=NEW.member_id AND s.purchase_request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'Sold purchases cannot be refunded twice' USING ERRCODE='23514';
  END IF;
  refunded:=target_private.receipt_financial_refund_amount(NEW.member_id,NEW.request_id)
    +target_private.receipt_duplicate_rebate_amount(NEW.member_id,NEW.request_id);
  refund_event:=target_private.receipt_financial_refund_event(NEW.member_id,NEW.request_id);
  IF refunded IS NULL OR refunded NOT BETWEEN 0 AND d.cost OR refunded%100<>0 OR
      NEW.wallet_refund_reset_id IS DISTINCT FROM refund_event OR
      NEW.additional_refund IS DISTINCT FROM d.cost-refunded THEN
    RAISE EXCEPTION 'Inventory refund must equal the exact receipt residual and proof event' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.target_sell_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $sell$
DECLARE member_uuid uuid; sale_uuid uuid; display_name text; pool_kind text; chosen_id text;
  saved target_private.item_sales%ROWTYPE; member_row target_private.profiles%ROWTYPE;
  chosen record; waits integer; bytes_needed integer; refunded bigint; total_purchase bigint;
BEGIN
 IF p_secret IS NULL OR length(p_secret)<32 OR length(p_secret)>256 OR NOT EXISTS(
   SELECT 1 FROM target_private.server_credentials WHERE singleton AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex'))
 THEN RETURN target_private.error_result(403,'RPC_FORBIDDEN','操作は許可されていません。'); END IF;
 IF p_action IS DISTINCT FROM 'sell' OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR pg_column_size(p_input)>4096 OR (SELECT count(*) FROM jsonb_object_keys(p_input))<>5
    OR NOT(p_input?&ARRAY['memberId','name','requestId','itemType','itemId'])
    OR coalesce(p_input->>'memberId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
    OR coalesce(p_input->>'requestId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
    OR jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string'
    OR length(btrim(coalesce(p_input->>'name',''))) NOT BETWEEN 1 AND 20
    OR p_input->'itemType' NOT IN ('"sticker"'::jsonb,'"frame"'::jsonb)
    OR jsonb_typeof(p_input->'itemId') IS DISTINCT FROM 'string'
    OR length(coalesce(p_input->>'itemId','')) NOT BETWEEN 1 AND 80
 THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
 member_uuid:=(p_input->>'memberId')::uuid; sale_uuid:=(p_input->>'requestId')::uuid;
 display_name:=btrim(p_input->>'name'); pool_kind:=p_input->>'itemType'; chosen_id:=p_input->>'itemId';
 PERFORM pg_advisory_xact_lock(991101);
 -- Permanent replay proof. A retry must never sell a second copy.
 SELECT * INTO saved FROM target_private.item_sales s WHERE s.member_id=member_uuid AND s.operation_id=sale_uuid;
 IF FOUND THEN
   IF saved.item_type IS DISTINCT FROM pool_kind OR saved.item_id IS DISTINCT FROM chosen_id
   THEN RETURN target_private.error_result(409,'REQUEST_ID_CONFLICT','同じ操作IDの内容が異なります。'); END IF;
   RETURN target_private.wallet_snapshot(member_uuid)||jsonb_build_object(
     'requestId',sale_uuid,'itemType',pool_kind,'itemId',chosen_id,'soldAmount',10000);
 END IF;
 DELETE FROM target_private.rate_limits WHERE expires_at<=clock_timestamp();
 waits:=target_private.consume_rate('shop-sell:'||member_uuid::text,60,20);
 IF waits>0 THEN
   RETURN jsonb_set(target_private.error_result(429,'RATE_LIMITED','しばらく待ってから再試行してください。'),'{error,retryAfter}',to_jsonb(waits));
 END IF;
 -- Caller supplies identity only through the secret-protected KGS server.
 IF NOT EXISTS(SELECT 1 FROM target_private.profiles WHERE member_id=member_uuid) THEN
   RETURN target_private.error_result(409,'ITEM_NOT_OWNED','このアイテムは持っていません。'); END IF;
 SELECT * INTO member_row FROM target_private.profiles WHERE member_id=member_uuid FOR UPDATE;
 IF pool_kind='sticker' AND NOT EXISTS(SELECT 1 FROM target_private.sticker_catalog WHERE id=chosen_id AND generation=5)
    OR pool_kind='frame' AND NOT EXISTS(SELECT 1 FROM target_private.frame_catalog WHERE id=chosen_id)
 THEN RETURN target_private.error_result(409,'ITEM_NOT_OWNED','売却できるアイテムがありません。'); END IF;
 SELECT request_id,item_type,item_id,drawn_at INTO chosen FROM target_private.active_gacha_receipts(member_uuid) d
   WHERE d.item_type=pool_kind AND d.item_id=chosen_id ORDER BY d.drawn_at,d.request_id LIMIT 1;
 IF NOT FOUND THEN RETURN target_private.error_result(409,'ITEM_NOT_OWNED','保有していないアイテムです。'); END IF;
 IF member_row.spent_points<10000 THEN RETURN target_private.error_result(409,'SALE_NOT_AVAILABLE','売却に必要な返還可能額がありません。'); END IF;
 SELECT coalesce(sum(cost),0)::bigint INTO total_purchase FROM target_private.gacha_receipts(member_uuid);
 SELECT coalesce((target_private.wallet_snapshot(member_uuid)->>'refundedSpend')::bigint,0) INTO refunded;
 IF refunded+10000>total_purchase THEN
   RETURN target_private.error_result(409,'SALE_NOT_AVAILABLE','返還可能な購入額が不足しています。'); END IF;
 bytes_needed:=pg_column_size(jsonb_build_object('member',member_uuid,'op',sale_uuid,'purchase',chosen.request_id,'type',pool_kind,'item',chosen_id))+256;
 IF (SELECT logical_bytes+bytes_needed>104857600 FROM target_private.system_state WHERE singleton FOR UPDATE)
 THEN RETURN target_private.error_result(507,'CAPACITY_LIMIT','保存容量が不足しています。'); END IF;
 INSERT INTO target_private.item_sales(member_id,operation_id,purchase_request_id,item_type,item_id,amount)
   VALUES(member_uuid,sale_uuid,chosen.request_id,pool_kind,chosen_id,10000);
 UPDATE target_private.profiles SET spent_points=spent_points-10000 WHERE member_id=member_uuid;
 UPDATE target_private.system_state SET logical_bytes=logical_bytes+bytes_needed WHERE singleton;
 RETURN target_private.wallet_snapshot(member_uuid)||jsonb_build_object(
   'requestId',sale_uuid,'itemType',pool_kind,'itemId',chosen_id,'soldAmount',10000);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR check_violation OR not_null_violation THEN
 RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
END $sell$;
REVOKE ALL ON FUNCTION public.target_sell_rpc(text,text,jsonb) FROM PUBLIC,anon,authenticated;
-- GRANT only service_role and postgres; never allow direct public/user calls.
GRANT EXECUTE ON FUNCTION public.target_sell_rpc(text,text,jsonb) TO service_role;
