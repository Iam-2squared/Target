-- Target: 10,000-todō rebate for each extra owned gacha copy.
-- KGS/Target real wallet is authoritative; one immutable credit per actual
-- purchase request, including historical duplicates not already fully refunded.
-- This migration is transactional. Target spending decreases, total income and
-- rankings do not change. Sticker and frame quantities are preserved.
-- Only the dedicated Target Supabase project should apply this migration.
SELECT pg_advisory_xact_lock(991101);
CREATE TABLE IF NOT EXISTS target_private.duplicate_rebates(
  member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
  request_id uuid NOT NULL,
  item_type text NOT NULL CHECK(item_type IN('sticker','frame')),
  item_id text NOT NULL,
  amount bigint NOT NULL DEFAULT 10000 CHECK(amount=10000),
  source text NOT NULL CHECK(source IN('historical','draw')),
  credited_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(credited_at)),
  PRIMARY KEY(member_id,request_id)
);
ALTER TABLE target_private.duplicate_rebates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE target_private.duplicate_rebates FROM PUBLIC,anon,authenticated;
-- No client role has table access. Security-definer shop RPC owns all writes.

CREATE OR REPLACE FUNCTION target_private.guard_duplicate_rebate_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $fn$
DECLARE r record;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  SELECT * INTO r FROM target_private.gacha_receipts(NEW.member_id) g
    WHERE g.request_id=NEW.request_id;
  IF NOT FOUND OR NEW.amount<>10000 OR NEW.item_type IS DISTINCT FROM r.item_type
       OR NEW.item_id IS DISTINCT FROM r.item_id
       OR EXISTS(SELECT 1 FROM target_private.inventory_voids v
         WHERE v.member_id=NEW.member_id AND v.request_id=NEW.request_id)
       OR target_private.receipt_financial_refund_amount(NEW.member_id,NEW.request_id) IS NULL
       OR r.cost-target_private.receipt_financial_refund_amount(NEW.member_id,NEW.request_id)<10000
       OR NOT EXISTS(SELECT 1 FROM target_private.active_gacha_receipts(NEW.member_id) prev
         WHERE prev.item_type=r.item_type AND prev.item_id=r.item_id
           AND (prev.drawn_at,prev.request_id)<(r.drawn_at,r.request_id)) THEN
    RAISE EXCEPTION 'Duplicate rebate requires an owned, eligible extra receipt'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION target_private.guard_duplicate_rebate_insert() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER duplicate_rebate_guard BEFORE INSERT ON target_private.duplicate_rebates
  FOR EACH ROW EXECUTE FUNCTION target_private.guard_duplicate_rebate_insert();
CREATE OR REPLACE FUNCTION target_private.prevent_duplicate_rebate_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $fn$
BEGIN
  RAISE EXCEPTION 'Duplicate rebate ledger is immutable' USING ERRCODE='42501';
END $fn$;
REVOKE ALL ON FUNCTION target_private.prevent_duplicate_rebate_mutation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER duplicate_rebate_immutable BEFORE UPDATE OR DELETE ON target_private.duplicate_rebates
  FOR EACH ROW EXECUTE FUNCTION target_private.prevent_duplicate_rebate_mutation();
CREATE OR REPLACE FUNCTION target_private.receipt_duplicate_rebate_amount(p_member uuid,p_request uuid)
RETURNS bigint LANGUAGE sql STABLE SET search_path TO 'pg_catalog' AS $fn$
  SELECT coalesce((SELECT amount FROM target_private.duplicate_rebates
    WHERE member_id=p_member AND request_id=p_request),0)::bigint;
$fn$;
REVOKE ALL ON FUNCTION target_private.receipt_duplicate_rebate_amount(uuid,uuid) FROM PUBLIC,anon,authenticated;

-- Adapt existing canonical function: target_private.receipt_financial_refund_amount
CREATE OR REPLACE FUNCTION target_private.receipt_financial_refund_amount(p_member uuid, p_request uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE WHEN target_private.receipt_wallet_refund(p_member,p_request) IS NOT NULL THEN d.cost::bigint-target_private.receipt_duplicate_rebate_amount(p_member,p_request)
    ELSE coalesce((SELECT sum(w.amount)::bigint FROM target_private.manual_receipt_writeoffs w
      WHERE w.member_id=p_member AND w.request_id=p_request),0) END
  FROM target_private.gacha_receipts(p_member) d WHERE d.request_id=p_request;
$function$;


-- Adapt existing canonical function: target_private.wallet_finance_projection
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
 gifts AS(SELECT a.member_id,sum(a.amount)::bigint amount FROM target_private.birthday_receipts a
   WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
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
     coalesce(x.amount,0)+coalesce(r.spent,0)-coalesce((SELECT sum(i.additional_refund) FROM target_private.inventory_voids i WHERE i.member_id=p.member_id AND (p_cutoff IS NULL OR i.created_at<p_cutoff)),0)-coalesce((SELECT sum(b.amount) FROM target_private.duplicate_rebates b WHERE b.member_id=p.member_id AND (p_cutoff IS NULL OR b.credited_at<p_cutoff)),0) spent,coalesce(x.map_amount,0) map_spent
   FROM target_private.profiles p LEFT JOIN study s USING(member_id) LEFT JOIN calculus c USING(member_id)
     LEFT JOIN voids v USING(member_id) LEFT JOIN recoveries z USING(member_id)
     LEFT JOIN gifts b USING(member_id) LEFT JOIN games g USING(member_id)
     LEFT JOIN spending x USING(member_id) LEFT JOIN corrections r USING(member_id))
 SELECT member_id,study+calculus+birthday+casino+forgiven,spent,calculus,birthday,casino,forgiven,study,map_spent FROM components;
$function$;


-- Adapt existing canonical function: target_private.wallet_snapshot
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
      +coalesce((SELECT sum(amount) FROM target_private.duplicate_rebates WHERE member_id=p_member),0) amount),
  voids AS(SELECT count(*)::integer amount FROM target_private.inventory_voids WHERE member_id=p_member)
  SELECT jsonb_build_object('balance',p.total_points-p.spent_points,'totalIncome',p.total_points,'spent',p.spent_points,'walletRevision',p.wallet_revision,
    'mapSpent',coalesce((SELECT sum(cost) FROM target_private.map_purchases WHERE member_id=p_member),0)+coalesce((SELECT sum(cost) FROM target_private.territory_orders WHERE member_id=p_member),0),
    'price',100000,'catalogVersion',5,'catalogSize',11,'frameCatalogSize',33,'duplicatesAllowed',true,
    'drawCount',(SELECT count(*)::integer FROM receipts),'legacyDiscountedDraws',(SELECT count(*)::integer FROM receipts WHERE cost=10000),
    'frameOdds',jsonb_build_object('common',62,'rare',25,'epic',10,'legendary',3),
    'ownedStickers',coalesce((SELECT jsonb_agg(c.id ORDER BY c.ordinal) FROM target_private.sticker_catalog c JOIN quantities q ON q.item_type='sticker' AND q.item_id=c.id AND c.generation=5),'[]'::jsonb),
    'stickerQuantities',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'quantity',q.quantity) ORDER BY c.ordinal) FROM target_private.sticker_catalog c JOIN quantities q ON q.item_type='sticker' AND q.item_id=c.id AND c.generation=5),'[]'::jsonb),
    'ownedFrames',coalesce((SELECT jsonb_agg(c.id ORDER BY c.ordinal) FROM target_private.frame_catalog c JOIN quantities q ON q.item_type='frame' AND q.item_id=c.id),'[]'::jsonb),
    'frameQuantities',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'quantity',q.quantity) ORDER BY c.ordinal) FROM target_private.frame_catalog c JOIN quantities q ON q.item_type='frame' AND q.item_id=c.id),'[]'::jsonb))
    ||CASE WHEN refunds.amount>0 THEN jsonb_build_object('refundedSpend',refunds.amount) ELSE '{}'::jsonb END
    ||CASE WHEN voids.amount>0 THEN jsonb_build_object('voidedDrawCount',voids.amount) ELSE '{}'::jsonb END
  
  FROM target_private.profiles p CROSS JOIN refunds CROSS JOIN voids WHERE p.member_id=p_member;
$function$;


-- Adapt existing canonical function: target_private.validate_manual_receipt_writeoff
CREATE OR REPLACE FUNCTION target_private.validate_manual_receipt_writeoff()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE receipt target_private.item_draws%rowtype; operation target_private.wallet_restorations%rowtype;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  SELECT * INTO STRICT receipt FROM target_private.item_draws
    WHERE member_id=NEW.member_id AND request_id=NEW.request_id;
  SELECT * INTO STRICT operation FROM target_private.wallet_restorations
    WHERE reset_id=NEW.reset_id AND member_id=NEW.member_id;
  IF receipt.cost<>100000 OR EXISTS(SELECT 1 FROM target_private.inventory_voids
      WHERE member_id=NEW.member_id AND request_id=NEW.request_id) OR
    target_private.receipt_wallet_refund(NEW.member_id,NEW.request_id) IS NOT NULL OR
    operation.component_deltas->'incomeCorrection'->>'kind' IS DISTINCT FROM 'authorized_zero_wallet_income_v1' OR
    (operation.restored_state->>'totalPoints')::bigint<>(operation.restored_state->>'spentPoints')::bigint OR
    NEW.amount+coalesce((SELECT sum(w.amount) FROM target_private.manual_receipt_writeoffs w
      WHERE w.member_id=NEW.member_id AND w.request_id=NEW.request_id),0)
      +target_private.receipt_duplicate_rebate_amount(NEW.member_id,NEW.request_id)>receipt.cost OR
    NEW.amount+coalesce((SELECT sum(w.amount) FROM target_private.manual_receipt_writeoffs w
      WHERE w.reset_id=NEW.reset_id AND w.member_id=NEW.member_id),0)>operation.spent_refund THEN
    RAISE EXCEPTION 'Manual spending write-off does not match an active unrefunded purchase' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;


-- Adapt existing canonical function: target_private.assert_receipt_refund_coverage
CREATE OR REPLACE FUNCTION target_private.assert_receipt_refund_coverage(p_member uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  IF EXISTS(SELECT 1 FROM target_private.manual_receipt_writeoffs w
      JOIN target_private.item_draws d USING(member_id,request_id)
      WHERE w.member_id=p_member GROUP BY w.member_id,w.request_id,d.cost HAVING sum(w.amount)+target_private.receipt_duplicate_rebate_amount(w.member_id,w.request_id)>d.cost) OR
    coalesce((SELECT sum(r.spent_refund) FROM target_private.wallet_restorations r WHERE r.member_id=p_member),0)
    <>coalesce((SELECT sum(target_private.receipt_financial_refund_amount(d.member_id,d.request_id))
      FROM target_private.gacha_receipts(p_member) d),0) THEN
    RAISE EXCEPTION 'Financial refund coverage does not match exact receipt amounts' USING ERRCODE='23514';
  END IF;
END $function$;


-- Adapt existing canonical function: target_private.validate_inventory_void
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


-- Adapt existing canonical function: target_private.zero_wallet_income
CREATE OR REPLACE FUNCTION target_private.zero_wallet_income(p_operation_id text, p_manifest jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  canonical jsonb; manifest_sha text; item jsonb; p target_private.profiles%rowtype;
  existing target_private.wallet_restoration_events%rowtype;
  before_snapshot jsonb; before_state jsonb; after_state jsonb; delta jsonb;
  applied_at timestamptz; members integer; desired bigint; amount bigint; next_casino bigint;
  audit_bytes bigint; writeoff bigint; remaining bigint; take_amount bigint; draw record;
  allocation_plan jsonb:='[]'::jsonb; allocation_count integer:=0;
BEGIN
  IF p_operation_id IS NULL OR p_operation_id!~'^zero_income_[a-zA-Z0-9_-]{1,68}$' OR
    p_manifest IS NULL OR jsonb_typeof(p_manifest)<>'object' OR pg_column_size(p_manifest)>131072 OR
    (SELECT count(*) FROM jsonb_object_keys(p_manifest))<>3 OR
    p_manifest->'version' IS DISTINCT FROM '1'::jsonb OR
    jsonb_typeof(p_manifest->'reason') IS DISTINCT FROM 'string' OR
    length(btrim(p_manifest->>'reason')) NOT BETWEEN 1 AND 200 OR
    jsonb_typeof(p_manifest->'targets') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid authorized income correction manifest' USING ERRCODE='22023';
  END IF;
  members:=jsonb_array_length(p_manifest->'targets');
  IF members NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Income correction must identify 1 to 500 members' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_manifest->'targets') LOOP
    IF jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>3 OR
      jsonb_typeof(item->'memberId') IS DISTINCT FROM 'string' OR
      coalesce(item->>'memberId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
      jsonb_typeof(item->'expectedName') IS DISTINCT FROM 'string' OR
      length(btrim(item->>'expectedName')) NOT BETWEEN 1 AND 20 OR
      jsonb_typeof(item->'totalIncome') IS DISTINCT FROM 'number' OR
      coalesce(item->>'totalIncome','')!~'^[0-9]{1,14}$' THEN
      RAISE EXCEPTION 'Invalid income correction member' USING ERRCODE='22023';
    END IF;
    desired:=(item->>'totalIncome')::bigint;
    IF desired NOT BETWEEN 0 AND 10000000000000 OR desired%10<>0 THEN
      RAISE EXCEPTION 'Requested income is outside the money bounds' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (value->>'memberId')::uuid) FROM jsonb_array_elements(p_manifest->'targets'))<>members THEN
    RAISE EXCEPTION 'Income correction contains a duplicate member' USING ERRCODE='22023';
  END IF;
  SELECT jsonb_build_object('version',1,'reason',btrim(p_manifest->>'reason'),'targets',jsonb_agg(
    jsonb_build_object('memberId',((value->>'memberId')::uuid)::text,'expectedName',btrim(value->>'expectedName'),
      'totalIncome',(value->>'totalIncome')::bigint) ORDER BY (value->>'memberId')::uuid)) INTO canonical
    FROM jsonb_array_elements(p_manifest->'targets');
  manifest_sha:=encode(sha256(convert_to(canonical::text,'UTF8')),'hex');

  PERFORM pg_advisory_xact_lock(991101);
  PERFORM 1 FROM target_private.system_state WHERE singleton FOR UPDATE;
  LOCK TABLE target_private.profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO existing FROM target_private.wallet_restoration_events WHERE reset_id=p_operation_id;
  IF FOUND THEN
    IF existing.source_manifest_sha256<>manifest_sha OR existing.member_count<>members OR
      (SELECT count(*) FROM target_private.wallet_restorations WHERE reset_id=p_operation_id)<>members OR
      EXISTS(SELECT 1 FROM target_private.wallet_restorations WHERE reset_id=p_operation_id
        AND component_deltas->'incomeCorrection'->>'kind' IS DISTINCT FROM 'authorized_zero_wallet_income_v1') THEN
      RAISE EXCEPTION 'Income correction ID is bound to different metadata' USING ERRCODE='22023';
    END IF;
    -- An operation replay must not erase income legitimately earned afterward.
    RETURN jsonb_build_object('operationId',p_operation_id,'members',members,'replayed',true);
  END IF;
  IF (SELECT count(*) FROM target_private.profiles live_profile JOIN jsonb_array_elements(canonical->'targets') t
      ON live_profile.member_id=(t->>'memberId')::uuid)<>members THEN
    RAISE EXCEPTION 'An income correction member does not exist' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles live_profile USING(member_id)
    WHERE (live_profile.total_points,live_profile.spent_points,live_profile.calculus_points,live_profile.birthday_points,live_profile.casino_net,live_profile.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet histories and current financial components disagree' USING ERRCODE='23514';
  END IF;
  -- Preflight the entire manifest before changing an audit row or wallet. This
  -- zero-wallet policy requires an exact, bounded purchase receipt write-off.
  FOR item IN SELECT value FROM jsonb_array_elements(canonical->'targets') LOOP
    SELECT * INTO STRICT p FROM target_private.profiles WHERE member_id=(item->>'memberId')::uuid FOR UPDATE;
    desired:=(item->>'totalIncome')::bigint; amount:=desired-p.total_points; next_casino:=p.casino_net+amount;
    IF p.name<>item->>'expectedName' THEN
      RAISE EXCEPTION 'Income correction member name changed' USING ERRCODE='23514';
    END IF;
    IF desired>p.spent_points OR desired%100<>0 OR desired<coalesce((
      SELECT sum(cost) FROM(SELECT cost FROM target_private.map_purchases WHERE member_id=p.member_id
        UNION ALL SELECT cost FROM target_private.territory_orders WHERE member_id=p.member_id) expenses),0) THEN
      RAISE EXCEPTION 'Zero-wallet correction cannot fabricate spending or refund map expenses' USING ERRCODE='23514';
    END IF;
    PERFORM target_private.assert_receipt_refund_coverage(p.member_id);
    remaining:=p.spent_points-desired;
    FOR draw IN SELECT d.request_id,d.cost-coalesce((SELECT sum(w.amount) FROM target_private.manual_receipt_writeoffs w
        WHERE w.member_id=d.member_id AND w.request_id=d.request_id),0)
        -target_private.receipt_duplicate_rebate_amount(d.member_id,d.request_id) AS available
      FROM target_private.item_draws d WHERE d.member_id=p.member_id AND d.cost=100000
        AND NOT EXISTS(SELECT 1 FROM target_private.inventory_voids v WHERE v.member_id=d.member_id AND v.request_id=d.request_id)
        AND target_private.receipt_wallet_refund(d.member_id,d.request_id) IS NULL
      ORDER BY d.created_at DESC,d.request_id DESC LOOP
      EXIT WHEN remaining=0;
      take_amount:=least(remaining,draw.available);
      IF take_amount<=0 THEN CONTINUE; END IF;
      allocation_count:=allocation_count+1;
      IF allocation_count>5000 THEN RAISE EXCEPTION 'Zero-wallet receipt plan exceeds capacity' USING ERRCODE='54000'; END IF;
      allocation_plan:=allocation_plan||jsonb_build_array(jsonb_build_object('memberId',p.member_id,
        'requestId',draw.request_id,'amount',take_amount));
      remaining:=remaining-take_amount;
    END LOOP;
    IF remaining<>0 THEN
      RAISE EXCEPTION 'Active unrefunded modern purchase receipts do not cover the spending write-off' USING ERRCODE='23514';
    END IF;
    IF next_casino NOT BETWEEN -10000000000000 AND 10000000000000 OR next_casino%10<>0 OR
      p.wallet_revision>=10000000000000 THEN
      RAISE EXCEPTION 'Income correction would exceed financial component bounds' USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT jsonb_object_agg(live_profile.member_id::text,target_private.wallet_finance_state(live_profile)) INTO before_snapshot
    FROM target_private.profiles live_profile JOIN jsonb_array_elements(canonical->'targets') t
      ON live_profile.member_id=(t->>'memberId')::uuid;
  audit_bytes:=1024+members*4096+allocation_count*512;
  UPDATE target_private.system_state SET logical_bytes=logical_bytes+audit_bytes
    WHERE singleton AND logical_bytes<=104857600-audit_bytes;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Income correction audit exceeds storage capacity' USING ERRCODE='54000';
  END IF;
  applied_at:=clock_timestamp();
  -- This is the true correction time, not a fabricated historical cutoff. The
  -- empty interval cannot pretend to fully refund any old purchase; exact
  -- full/partial write-offs are instead recorded in the allocation ledger.
  INSERT INTO target_private.wallet_restoration_events(reset_id,cutoff_at,prepared_at,source_manifest_sha256,
    before_snapshot_sha256,member_count) VALUES(p_operation_id,applied_at,applied_at,manifest_sha,
      encode(sha256(convert_to(before_snapshot::text,'UTF8')),'hex'),members);
  FOR item IN SELECT value FROM jsonb_array_elements(canonical->'targets') LOOP
    SELECT * INTO STRICT p FROM target_private.profiles WHERE member_id=(item->>'memberId')::uuid;
    before_state:=before_snapshot->p.member_id::text;
    desired:=(item->>'totalIncome')::bigint; amount:=desired-p.total_points; writeoff:=p.spent_points-desired;
    -- casino_net is the existing signed non-study correction component. Record
    -- an explicit operator correction; never invent or rewrite a game receipt.
    UPDATE target_private.profiles SET total_points=desired,spent_points=desired,casino_net=casino_net+amount,updated_at=now()
      WHERE member_id=p.member_id RETURNING target_private.wallet_finance_state(profiles) INTO after_state;
    delta:=jsonb_build_object('totalPoints',amount,'spentPoints',-writeoff,'calculusPoints',0,'birthdayPoints',0,
      'casinoNet',amount,'calculusForgivenPoints',0,'rawStudyPoints',0,
      'incomeCorrection',jsonb_build_object('kind','authorized_zero_wallet_income_v1','version',1,
        'reason',canonical->>'reason','memberId',item->>'memberId','expectedName',item->>'expectedName',
        'totalIncome',desired,'spendingPolicy','zero_balance_preserve_inventory'));
    INSERT INTO target_private.wallet_restorations(reset_id,member_id,before_state,after_void_state,restored_state,
      component_deltas,spent_refund) VALUES(p_operation_id,p.member_id,before_state,before_state,after_state,delta,writeoff);
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(allocation_plan) LOOP
    INSERT INTO target_private.manual_receipt_writeoffs(reset_id,member_id,request_id,amount)
      VALUES(p_operation_id,(item->>'memberId')::uuid,(item->>'requestId')::uuid,(item->>'amount')::integer);
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(canonical->'targets') LOOP
    SELECT spent_refund INTO writeoff FROM target_private.wallet_restorations
      WHERE reset_id=p_operation_id AND member_id=(item->>'memberId')::uuid;
    IF writeoff<>(SELECT coalesce(sum(w.amount),0) FROM target_private.manual_receipt_writeoffs w
        WHERE reset_id=p_operation_id AND member_id=(item->>'memberId')::uuid) THEN
      RAISE EXCEPTION 'Spending write-off does not match its exact receipt allocations' USING ERRCODE='23514';
    END IF;
    PERFORM target_private.assert_receipt_refund_coverage((item->>'memberId')::uuid);
  END LOOP;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles live_profile USING(member_id)
    WHERE (live_profile.total_points,live_profile.spent_points,live_profile.calculus_points,live_profile.birthday_points,live_profile.casino_net,live_profile.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Income correction does not reconcile with the permanent ledger' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('operationId',p_operation_id,'members',members,'replayed',false);
END $function$;


-- Adapt existing canonical function: target_private.restore_inventory
CREATE OR REPLACE FUNCTION target_private.restore_inventory(p_reset_id text, p_cutoff timestamp with time zone, p_wallet_reset_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE e target_private.inventory_restoration_events%rowtype; base target_private.wallet_restoration_events%rowtype;
  p target_private.profiles%rowtype; draw_value record; prepared timestamptz; before_states jsonb; before_value jsonb; after_value jsonb;
  members integer; draws integer; new_refund bigint; refund_for_member bigint; voids_for_member integer; audit_bytes bigint;
BEGIN
  IF p_reset_id IS NULL OR p_reset_id!~'^[a-zA-Z0-9_-]{1,80}$' OR p_cutoff IS NULL OR NOT isfinite(p_cutoff)
    OR p_cutoff>clock_timestamp() OR p_wallet_reset_id IS NULL THEN
    RAISE EXCEPTION 'Invalid inventory restoration metadata' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(991101);
  PERFORM 1 FROM target_private.system_state WHERE singleton FOR UPDATE;
  LOCK TABLE target_private.profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO e FROM target_private.inventory_restoration_events WHERE reset_id=p_reset_id;
  IF FOUND THEN
    IF e.cutoff_at<>p_cutoff OR e.base_wallet_reset_id<>p_wallet_reset_id THEN
      RAISE EXCEPTION 'Inventory restoration ID has different metadata' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('resetId',e.reset_id,'cutoffAt',e.cutoff_at,'members',e.member_count,
      'voidedDraws',e.voided_draw_count,'additionalRefund',e.additional_refund,'replayed',true);
  END IF;
  SELECT * INTO base FROM target_private.wallet_restoration_events WHERE reset_id=p_wallet_reset_id;
  IF NOT FOUND OR base.cutoff_at<>p_cutoff THEN RAISE EXCEPTION 'Matching completed financial restoration is required' USING ERRCODE='23514'; END IF;
  prepared:=clock_timestamp();
  IF EXISTS(SELECT 1 FROM target_private.sticker_draws WHERE created_at>=p_cutoff) OR EXISTS(
    SELECT 1 FROM target_private.inventory_voids WHERE drawn_at<p_cutoff) THEN
    RAISE EXCEPTION 'Historical legacy or earlier inventory tombstones need a separate reviewed policy' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles a USING(member_id)
    WHERE (a.total_points,a.spent_points,a.calculus_points,a.birthday_points,a.casino_net,a.calculus_forgiven_points)
      IS DISTINCT FROM(l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Current wallet components do not reconcile' USING ERRCODE='23514'; END IF;
  -- Aggregate financial refunds must identify the exact immutable receipt set.
  IF EXISTS(SELECT 1 FROM target_private.profiles a WHERE
    coalesce((SELECT sum(r.spent_refund) FROM target_private.wallet_restorations r WHERE r.member_id=a.member_id),0)<>
    coalesce((SELECT sum(target_private.receipt_financial_refund_amount(r.member_id,r.request_id))
      FROM target_private.gacha_receipts(a.member_id) r),0)) THEN
    RAISE EXCEPTION 'Financial refund coverage cannot be assigned exactly to purchase receipts' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO members FROM target_private.profiles;
  SELECT count(*)::integer,coalesce(sum(d.cost-target_private.receipt_financial_refund_amount(d.member_id,d.request_id)-target_private.receipt_duplicate_rebate_amount(d.member_id,d.request_id)),0)::bigint
    INTO draws,new_refund FROM target_private.item_draws d WHERE d.created_at>=p_cutoff
      AND NOT EXISTS(SELECT 1 FROM target_private.inventory_voids v WHERE v.member_id=d.member_id AND v.request_id=d.request_id);
  IF EXISTS(SELECT 1 FROM target_private.profiles a WHERE a.wallet_revision>=10000000000000 OR a.spent_points<
    coalesce((SELECT sum(d.cost-target_private.receipt_financial_refund_amount(d.member_id,d.request_id)-target_private.receipt_duplicate_rebate_amount(d.member_id,d.request_id))
      FROM target_private.item_draws d WHERE d.member_id=a.member_id AND d.created_at>=p_cutoff
      AND NOT EXISTS(SELECT 1 FROM target_private.inventory_voids v WHERE v.member_id=d.member_id AND v.request_id=d.request_id)),0)) THEN
    RAISE EXCEPTION 'Inventory refund or revision exceeds the current financial bounds' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_object_agg(a.member_id::text,target_private.wallet_snapshot(a.member_id)),'{}'::jsonb)
    INTO before_states FROM target_private.profiles a;
  audit_bytes:=1024+members*16384+draws*768;
  UPDATE target_private.system_state SET logical_bytes=logical_bytes+audit_bytes WHERE singleton AND logical_bytes<=104857600-audit_bytes;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inventory restoration audit exceeds capacity' USING ERRCODE='54000'; END IF;
  INSERT INTO target_private.inventory_restoration_events(reset_id,cutoff_at,base_wallet_reset_id,prepared_at,member_count,
    voided_draw_count,additional_refund,before_inventory_sha256)
    VALUES(p_reset_id,p_cutoff,p_wallet_reset_id,prepared,members,draws,new_refund,encode(sha256(convert_to(before_states::text,'UTF8')),'hex'));
  FOR draw_value IN SELECT d.* FROM target_private.item_draws d WHERE d.created_at>=p_cutoff
    AND NOT EXISTS(SELECT 1 FROM target_private.inventory_voids v WHERE v.member_id=d.member_id AND v.request_id=d.request_id)
    ORDER BY d.member_id,d.created_at,d.request_id LOOP
    INSERT INTO target_private.inventory_voids(member_id,request_id,reset_id,item_type,item_id,cost,drawn_at,wallet_refund_reset_id,additional_refund)
      SELECT draw_value.member_id,draw_value.request_id,p_reset_id,draw_value.item_type,coalesce(draw_value.sticker_id,draw_value.frame_id),draw_value.cost,draw_value.created_at,
        proof.reset_id,draw_value.cost-target_private.receipt_financial_refund_amount(draw_value.member_id,draw_value.request_id)-target_private.receipt_duplicate_rebate_amount(draw_value.member_id,draw_value.request_id)
      FROM(SELECT target_private.receipt_financial_refund_event(draw_value.member_id,draw_value.request_id) reset_id) proof;
  END LOOP;
  FOR p IN SELECT * FROM target_private.profiles ORDER BY member_id LOOP
    SELECT coalesce(sum(additional_refund),0),count(*)::integer INTO refund_for_member,voids_for_member
      FROM target_private.inventory_voids WHERE reset_id=p_reset_id AND member_id=p.member_id;
    before_value:=before_states->p.member_id::text;
    UPDATE target_private.profiles SET total_points=total_points,spent_points=spent_points-refund_for_member,updated_at=now()
      WHERE member_id=p.member_id;
    after_value:=target_private.wallet_snapshot(p.member_id);
    INSERT INTO target_private.inventory_restorations(reset_id,member_id,before_state,restored_state,voided_draw_count,additional_refund)
      VALUES(p_reset_id,p.member_id,before_value,after_value,voids_for_member,refund_for_member);
  END LOOP;
  IF EXISTS(SELECT 1 FROM target_private.active_gacha_receipts(NULL) WHERE drawn_at>=p_cutoff) OR EXISTS(
    SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles a USING(member_id)
    WHERE (a.total_points,a.spent_points,a.calculus_points,a.birthday_points,a.casino_net,a.calculus_forgiven_points)
      IS DISTINCT FROM(l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Inventory restoration does not reconcile with active receipts and financial history' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('resetId',p_reset_id,'cutoffAt',p_cutoff,'members',members,'voidedDraws',draws,'additionalRefund',new_refund,'replayed',false);
END $function$;


-- Adapt existing canonical function: target_private.retire_stickers
CREATE OR REPLACE FUNCTION target_private.retire_stickers(p_reset_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  operation_id constant text:='sticker_retire_20261110_v1';
  e target_private.inventory_restoration_events%rowtype;
  prepared timestamptz; before_wallets jsonb; before_profiles jsonb; before_history jsonb:='{}'::jsonb;
  after_history jsonb:='{}'::jsonb; before_system jsonb; logical_before bigint;
  plan jsonb; item jsonb; p target_private.profiles%rowtype; after_wallet jsonb;
  members integer; draws integer; refund_total bigint; member_refund bigint; member_voids integer; audit_bytes bigint;
  relation text; digest text; table_filter text;
BEGIN
  IF p_reset_id IS DISTINCT FROM operation_id THEN
    RAISE EXCEPTION 'Invalid authorized sticker retirement operation' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(991101);
  SELECT logical_bytes,to_jsonb(s)-'logical_bytes' INTO STRICT logical_before,before_system
    FROM target_private.system_state s WHERE singleton FOR UPDATE;
  LOCK TABLE target_private.profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO e FROM target_private.inventory_restoration_events WHERE reset_id=operation_id;
  IF FOUND THEN
    IF e.base_wallet_reset_id IS NOT NULL OR e.cutoff_at IS DISTINCT FROM e.prepared_at OR
      e.member_count<>(SELECT count(*) FROM target_private.inventory_restorations WHERE reset_id=operation_id) OR
      e.voided_draw_count<>(SELECT count(*) FROM target_private.inventory_voids WHERE reset_id=operation_id) OR
      e.additional_refund<>(SELECT coalesce(sum(additional_refund),0) FROM target_private.inventory_voids WHERE reset_id=operation_id) OR
      e.additional_refund<>(SELECT coalesce(sum(additional_refund),0) FROM target_private.inventory_restorations WHERE reset_id=operation_id) OR
      EXISTS(SELECT 1 FROM target_private.inventory_voids WHERE reset_id=operation_id AND item_type<>'sticker') OR
      e.before_inventory_sha256<>(SELECT encode(sha256(convert_to(coalesce(jsonb_object_agg(member_id::text,before_state),'{}'::jsonb)::text,'UTF8')),'hex')
        FROM target_private.inventory_restorations WHERE reset_id=operation_id) THEN
      RAISE EXCEPTION 'Sticker retirement audit metadata disagrees' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('operationId',operation_id,'members',e.member_count,'voidedDraws',e.voided_draw_count,
      'refundedAmount',e.additional_refund,'replayed',true,'totalIncomeUnchanged',true,'framesPreserved',true);
  END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles a USING(member_id)
    WHERE (a.total_points,a.spent_points,a.calculus_points,a.birthday_points,a.casino_net,a.calculus_forgiven_points)
      IS DISTINCT FROM(l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet history does not reconcile before sticker retirement' USING ERRCODE='23514'; END IF;
  FOR p IN SELECT a.* FROM target_private.profiles a WHERE EXISTS(
      SELECT 1 FROM target_private.active_gacha_receipts(a.member_id) WHERE item_type='sticker') ORDER BY member_id LOOP
    PERFORM target_private.assert_receipt_refund_coverage(p.member_id);
  END LOOP;
  IF EXISTS(SELECT 1 FROM target_private.active_gacha_receipts(NULL) d WHERE d.item_type='sticker' AND
      (target_private.receipt_financial_refund_amount(d.member_id,d.request_id) IS NULL OR
       target_private.receipt_financial_refund_amount(d.member_id,d.request_id) NOT BETWEEN 0 AND d.cost OR
       target_private.receipt_financial_refund_amount(d.member_id,d.request_id)%100<>0)) THEN
    RAISE EXCEPTION 'Sticker refund coverage is not canonical' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('memberId',d.member_id::text,'requestId',d.request_id::text,
      'itemId',d.item_id,'cost',d.cost,'drawnAt',d.drawn_at,
      'refundedAmount',d.cost-target_private.receipt_financial_refund_amount(d.member_id,d.request_id)-target_private.receipt_duplicate_rebate_amount(d.member_id,d.request_id),
      'financialEvent',target_private.receipt_financial_refund_event(d.member_id,d.request_id))
      ORDER BY d.member_id,d.drawn_at,d.request_id),'[]'::jsonb),count(*)::integer,
      count(DISTINCT d.member_id)::integer,
      coalesce(sum(d.cost-target_private.receipt_financial_refund_amount(d.member_id,d.request_id)-target_private.receipt_duplicate_rebate_amount(d.member_id,d.request_id)),0)::bigint
    INTO plan,draws,members,refund_total FROM target_private.active_gacha_receipts(NULL) d WHERE item_type='sticker';
  IF members>500 OR draws>100000000 OR refund_total>10000000000000 THEN
    RAISE EXCEPTION 'Sticker retirement audit exceeds representation limits' USING ERRCODE='54000'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.profiles a WHERE EXISTS(
      SELECT 1 FROM jsonb_array_elements(plan) t WHERE (t->>'memberId')::uuid=a.member_id) AND
    (a.wallet_revision>=10000000000000 OR a.spent_points<(SELECT coalesce(sum((t->>'refundedAmount')::bigint),0)
      FROM jsonb_array_elements(plan) t WHERE (t->>'memberId')::uuid=a.member_id))) THEN
    RAISE EXCEPTION 'Sticker refund exceeds spending or wallet revision bounds' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_object_agg(a.member_id::text,to_jsonb(a)),'{}'::jsonb) INTO before_profiles FROM target_private.profiles a;
  SELECT coalesce(jsonb_object_agg(a.member_id::text,target_private.wallet_snapshot(a.member_id)),'{}'::jsonb)
    INTO before_wallets FROM target_private.profiles a WHERE EXISTS(
      SELECT 1 FROM jsonb_array_elements(plan) t WHERE (t->>'memberId')::uuid=a.member_id);
  FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='target_private' AND c.relkind='r' AND c.relname NOT IN ('profiles','system_state','rate_limits','two_player_lobby_presence')
      AND c.relname NOT LIKE '%credentials' AND c.relname NOT LIKE '%rates' ORDER BY c.relname LOOP
    table_filter:=CASE WHEN relation IN ('inventory_restoration_events','inventory_voids','inventory_restorations')
      THEN format(' WHERE reset_id<>%L',operation_id) ELSE '' END;
    EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text),%L ORDER BY md5(to_jsonb(t)::text)),%L)) FROM target_private.%I t%s',
      '','',relation,table_filter) INTO digest;
    before_history:=before_history||jsonb_build_object(relation,digest);
  END LOOP;
  audit_bytes:=1024+members*16384::bigint+draws*768::bigint;
  UPDATE target_private.system_state SET logical_bytes=logical_bytes+audit_bytes
    WHERE singleton AND logical_bytes<=104857600-audit_bytes;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sticker retirement audit exceeds storage capacity' USING ERRCODE='54000'; END IF;
  prepared:=clock_timestamp();
  INSERT INTO target_private.inventory_restoration_events(reset_id,cutoff_at,base_wallet_reset_id,prepared_at,
      member_count,voided_draw_count,additional_refund,before_inventory_sha256)
    VALUES(operation_id,prepared,NULL,prepared,members,draws,refund_total,
      encode(sha256(convert_to(before_wallets::text,'UTF8')),'hex'));
  FOR item IN SELECT value FROM jsonb_array_elements(plan) LOOP
    INSERT INTO target_private.inventory_voids(member_id,request_id,reset_id,item_type,item_id,cost,drawn_at,
        wallet_refund_reset_id,additional_refund)
      VALUES((item->>'memberId')::uuid,(item->>'requestId')::uuid,operation_id,'sticker',item->>'itemId',
        (item->>'cost')::integer,(item->>'drawnAt')::timestamptz,item->>'financialEvent',(item->>'refundedAmount')::bigint);
  END LOOP;
  FOR p IN SELECT a.* FROM target_private.profiles a WHERE before_wallets?a.member_id::text ORDER BY member_id LOOP
    SELECT count(*)::integer,coalesce(sum(additional_refund),0)::bigint INTO member_voids,member_refund
      FROM target_private.inventory_voids WHERE reset_id=operation_id AND member_id=p.member_id;
    UPDATE target_private.profiles SET spent_points=spent_points-member_refund,updated_at=now() WHERE member_id=p.member_id;
    after_wallet:=target_private.wallet_snapshot(p.member_id);
    IF (after_wallet->>'totalIncome')::bigint<>(before_wallets->p.member_id::text->>'totalIncome')::bigint OR
      after_wallet->'ownedFrames' IS DISTINCT FROM before_wallets->p.member_id::text->'ownedFrames' OR
      after_wallet->'frameQuantities' IS DISTINCT FROM before_wallets->p.member_id::text->'frameQuantities' OR
      after_wallet->'ownedStickers'<>'[]'::jsonb OR after_wallet->'stickerQuantities'<>'[]'::jsonb THEN
      RAISE EXCEPTION 'Sticker retirement changed income or frames, or left active stickers' USING ERRCODE='23514'; END IF;
    INSERT INTO target_private.inventory_restorations(reset_id,member_id,before_state,restored_state,voided_draw_count,additional_refund)
      VALUES(operation_id,p.member_id,before_wallets->p.member_id::text,after_wallet,member_voids,member_refund);
  END LOOP;
  IF EXISTS(SELECT 1 FROM target_private.active_gacha_receipts(NULL) WHERE item_type='sticker') OR
    EXISTS(SELECT 1 FROM target_private.profiles a WHERE
      CASE WHEN before_wallets?a.member_id::text THEN
        to_jsonb(a)-ARRAY['spent_points','wallet_revision','updated_at'] IS DISTINCT FROM
          (before_profiles->a.member_id::text)-ARRAY['spent_points','wallet_revision','updated_at'] OR
        a.wallet_revision<>((before_profiles->a.member_id::text)->>'wallet_revision')::bigint+1 OR
        a.spent_points<>((before_profiles->a.member_id::text)->>'spent_points')::bigint-
          (SELECT additional_refund FROM target_private.inventory_restorations WHERE reset_id=operation_id AND member_id=a.member_id)
      ELSE to_jsonb(a) IS DISTINCT FROM before_profiles->a.member_id::text END) THEN
    RAISE EXCEPTION 'Sticker retirement altered unrelated wallet fields' USING ERRCODE='23514'; END IF;
  FOR relation IN SELECT jsonb_object_keys(before_history) LOOP
    table_filter:=CASE WHEN relation IN ('inventory_restoration_events','inventory_voids','inventory_restorations')
      THEN format(' WHERE reset_id<>%L',operation_id) ELSE '' END;
    EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text),%L ORDER BY md5(to_jsonb(t)::text)),%L)) FROM target_private.%I t%s',
      '','',relation,table_filter) INTO digest;
    after_history:=after_history||jsonb_build_object(relation,digest);
  END LOOP;
  IF after_history IS DISTINCT FROM before_history OR
      (SELECT logical_bytes FROM target_private.system_state WHERE singleton)<>logical_before+audit_bytes OR
      (SELECT to_jsonb(s)-'logical_bytes' FROM target_private.system_state s WHERE singleton) IS DISTINCT FROM before_system THEN
    RAISE EXCEPTION 'Sticker retirement changed prior source, item, match or audit history' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles a USING(member_id)
    WHERE (a.total_points,a.spent_points,a.calculus_points,a.birthday_points,a.casino_net,a.calculus_forgiven_points)
      IS DISTINCT FROM(l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet history does not reconcile after sticker retirement' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('operationId',operation_id,'members',members,'voidedDraws',draws,'refundedAmount',refund_total,
    'replayed',false,'totalIncomeUnchanged',true,'framesPreserved',true);
END $function$;


-- Adapt existing canonical function: public.target_shop_rpc
CREATE OR REPLACE FUNCTION public.target_shop_rpc(p_secret text, p_action text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  member_uuid uuid; request_uuid uuid; display_name text; pool_kind text;
  saved_legacy target_private.sticker_draws%ROWTYPE; saved target_private.item_draws%ROWTYPE;
  profile target_private.profiles%ROWTYPE; chosen_id text; chosen_rarity text;
  chosen_count integer; wait_seconds integer; new_bytes integer; quantity integer; receipt_voided boolean:=false; duplicate_draw boolean:=false;
BEGIN
  IF p_secret IS NULL OR length(p_secret)<32 OR length(p_secret)>256 OR NOT EXISTS(
    SELECT 1 FROM target_private.server_credentials WHERE singleton AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
    RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('wallet','draw') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR pg_column_size(p_input)>4096 THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>(CASE WHEN p_action='draw' THEN 3+(p_input?'expectedPrice')::integer+(p_input?'expectedCatalogVersion')::integer+(p_input?'itemType')::integer ELSE 2 END) OR
    coalesce(p_input->>'memberId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
    jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR length(btrim(coalesce(p_input->>'name','')))<1 OR length(btrim(p_input->>'name'))>20 OR
    (p_action='wallet' AND NOT(p_input?&ARRAY['memberId','name'])) OR
    (p_action='draw' AND (NOT(p_input?&ARRAY['memberId','name','requestId']) OR coalesce(p_input->>'requestId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
      (p_input?'expectedPrice' AND p_input->'expectedPrice' NOT IN ('10000'::jsonb,'100000'::jsonb)) OR
      (p_input?'expectedCatalogVersion' AND p_input->'expectedCatalogVersion' NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb)) OR
      (p_input?'itemType' AND p_input->'itemType' NOT IN ('"sticker"'::jsonb,'"frame"'::jsonb)))) THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
  END IF;
  member_uuid:=(p_input->>'memberId')::uuid; display_name:=btrim(p_input->>'name'); pool_kind:=coalesce(p_input->>'itemType','sticker');
  PERFORM pg_advisory_xact_lock(991101);
  IF p_action='draw' AND NOT EXISTS(
    SELECT 1 FROM target_private.gacha_receipts(member_uuid) WHERE request_id=(p_input->>'requestId')::uuid) AND
    (coalesce((p_input->>'expectedCatalogVersion')::integer,1)<>5 OR NOT(p_input?'itemType')) THEN
    RETURN target_private.error_result(409,'CATALOG_CHANGED','ガチャの内容が変わりました。確認してからもう一度操作してください。'); END IF;
  DELETE FROM target_private.rate_limits WHERE expires_at<=clock_timestamp();
  IF NOT EXISTS(SELECT 1 FROM target_private.profiles WHERE member_id=member_uuid) AND (SELECT count(*) FROM target_private.profiles)>=500 THEN
    RETURN target_private.error_result(507,'CAPACITY_LIMIT','登録人数の上限に達しました。');
  END IF;
  INSERT INTO target_private.profiles(member_id,name) VALUES(member_uuid,display_name) ON CONFLICT(member_id) DO UPDATE SET name=excluded.name,
    updated_at=CASE WHEN target_private.profiles.name IS DISTINCT FROM excluded.name THEN now() ELSE target_private.profiles.updated_at END;
  SELECT * INTO profile FROM target_private.profiles WHERE member_id=member_uuid FOR UPDATE;
  IF p_action='wallet' THEN
    wait_seconds:=target_private.consume_rate('shop-wallet:'||member_uuid::text,60,180);
    IF wait_seconds>0 THEN RETURN jsonb_set(target_private.error_result(429,'RATE_LIMITED','しばらく待ってからお試しください。'),'{error,retryAfter}',to_jsonb(wait_seconds)); END IF;
    RETURN target_private.wallet_snapshot(member_uuid);
  END IF;
  request_uuid:=(p_input->>'requestId')::uuid;
  SELECT * INTO saved_legacy FROM target_private.sticker_draws WHERE member_id=member_uuid AND request_id=request_uuid;
  IF FOUND THEN
    IF pool_kind<>'sticker' THEN RETURN target_private.error_result(409,'REQUEST_ID_CONFLICT','同じ操作IDの内容が異なります。'); END IF;
    SELECT count(*)::integer INTO quantity FROM target_private.active_gacha_receipts(member_uuid) d WHERE d.item_type='sticker' AND d.item_id=saved_legacy.sticker_id;
    RETURN target_private.wallet_snapshot(member_uuid)||jsonb_build_object('requestId',request_uuid,'itemType','sticker','itemId',saved_legacy.sticker_id,'stickerId',saved_legacy.sticker_id,'cost',saved_legacy.cost,'quantity',quantity)||
      CASE WHEN EXISTS(SELECT 1 FROM target_private.inventory_voids WHERE member_id=member_uuid AND request_id=request_uuid)
      THEN jsonb_build_object('receiptVoided',true) ELSE '{}'::jsonb END||
      CASE WHEN EXISTS(SELECT 1 FROM target_private.duplicate_rebates b WHERE b.member_id=member_uuid AND b.request_id=request_uuid)
      THEN jsonb_build_object('duplicateRefund',10000) ELSE '{}'::jsonb END;
  END IF;
  SELECT * INTO saved FROM target_private.item_draws WHERE member_id=member_uuid AND request_id=request_uuid;
  IF FOUND THEN
    IF pool_kind<>saved.item_type THEN RETURN target_private.error_result(409,'REQUEST_ID_CONFLICT','同じ操作IDの内容が異なります。'); END IF;
    receipt_voided:=EXISTS(SELECT 1 FROM target_private.inventory_voids WHERE member_id=member_uuid AND request_id=request_uuid); chosen_id:=coalesce(saved.sticker_id,saved.frame_id); chosen_rarity:=(SELECT rarity FROM target_private.frame_catalog WHERE id=saved.frame_id);
  ELSE
    IF coalesce((p_input->>'expectedPrice')::integer,10000)<>100000 THEN RETURN target_private.error_result(409,'PRICE_CHANGED','価格を確認してからもう一度操作してください。'); END IF;
    IF coalesce((p_input->>'expectedCatalogVersion')::integer,1)<>5 OR NOT(p_input?'itemType') THEN RETURN target_private.error_result(409,'CATALOG_CHANGED','ガチャの内容が変わりました。確認してからもう一度操作してください。'); END IF;
    wait_seconds:=target_private.consume_rate('shop-draw:'||member_uuid::text,60,10);
    IF wait_seconds>0 THEN RETURN jsonb_set(target_private.error_result(429,'RATE_LIMITED','しばらく待ってからお試しください。'),'{error,retryAfter}',to_jsonb(wait_seconds)); END IF;
    IF profile.total_points-profile.spent_points<100000 THEN RETURN target_private.error_result(409,'INSUFFICIENT_BALANCE','保有金額が100,000轟に足りません。'); END IF;
    IF pool_kind='sticker' THEN
      SELECT id INTO chosen_id FROM target_private.sticker_catalog WHERE generation=5 ORDER BY ordinal OFFSET target_private.secure_random_int(11) LIMIT 1;
    ELSE
      chosen_rarity:=target_private.frame_rarity_for_roll(target_private.secure_random_int(10000));
      SELECT count(*)::integer INTO chosen_count FROM target_private.frame_catalog WHERE rarity=chosen_rarity;
      SELECT id INTO chosen_id FROM target_private.frame_catalog WHERE rarity=chosen_rarity ORDER BY ordinal OFFSET target_private.secure_random_int(chosen_count) LIMIT 1;
    END IF;
    duplicate_draw:=EXISTS(SELECT 1 FROM target_private.active_gacha_receipts(member_uuid) a WHERE a.item_type=pool_kind AND a.item_id=chosen_id);
    new_bytes:=pg_column_size(jsonb_build_object('memberId',member_uuid,'requestId',request_uuid,'itemType',pool_kind,'itemId',chosen_id,'cost',100000))+320+CASE WHEN duplicate_draw THEN 256 ELSE 0 END;
    IF (SELECT logical_bytes+new_bytes>104857600 FROM target_private.system_state WHERE singleton FOR UPDATE) THEN RETURN target_private.error_result(507,'CAPACITY_LIMIT','保存容量の上限に達しました。'); END IF;
    PERFORM set_config('target.gacha_inventory_protocol','active-v1',true); PERFORM set_config('target.gacha_price_protocol','100000',true); PERFORM set_config('target.gacha_catalog_protocol','5',true);
    INSERT INTO target_private.item_draws(member_id,request_id,item_type,sticker_id,frame_id,cost) VALUES(member_uuid,request_uuid,pool_kind,CASE WHEN pool_kind='sticker' THEN chosen_id END,CASE WHEN pool_kind='frame' THEN chosen_id END,100000) RETURNING * INTO saved;
    IF duplicate_draw THEN
      INSERT INTO target_private.duplicate_rebates(member_id,request_id,item_type,item_id,source)
        VALUES(member_uuid,request_uuid,pool_kind,chosen_id,'draw');
    END IF;
    UPDATE target_private.profiles SET spent_points=spent_points+100000-CASE WHEN duplicate_draw THEN 10000 ELSE 0 END WHERE member_id=member_uuid;
    UPDATE target_private.system_state SET logical_bytes=logical_bytes+new_bytes WHERE singleton;
  END IF;
  IF saved.item_type='sticker' THEN
    SELECT count(*)::integer INTO quantity FROM target_private.active_gacha_receipts(member_uuid) d WHERE d.item_type='sticker' AND d.item_id=chosen_id;
  ELSE SELECT count(*)::integer INTO quantity FROM target_private.active_gacha_receipts(member_uuid) WHERE item_type='frame' AND item_id=chosen_id; END IF;
  RETURN target_private.wallet_snapshot(member_uuid)||jsonb_build_object('requestId',request_uuid,'itemType',saved.item_type,'itemId',chosen_id,'cost',saved.cost,'quantity',quantity)||CASE WHEN receipt_voided THEN jsonb_build_object('receiptVoided',true) ELSE '{}'::jsonb END||
    CASE WHEN saved.item_type='sticker' THEN jsonb_build_object('stickerId',chosen_id) ELSE jsonb_build_object('frameId',chosen_id,'rarity',chosen_rarity) END||
    CASE WHEN EXISTS(SELECT 1 FROM target_private.duplicate_rebates b WHERE b.member_id=member_uuid AND b.request_id=request_uuid)
    THEN jsonb_build_object('duplicateRefund',10000) ELSE '{}'::jsonb END;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR check_violation OR not_null_violation THEN
  RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
END $function$;


-- Credit each still-owned extra once, omitting fully refunded receipts. The
-- immutable (member, request) key guarantees idempotence under retries.
DO $backfill$
DECLARE credited_count bigint; member_count bigint; applied_count bigint; credit_total bigint;
BEGIN
  WITH ranked AS MATERIALIZED(
    SELECT r.*,row_number() OVER(PARTITION BY r.member_id,r.item_type,r.item_id
      ORDER BY r.drawn_at,r.request_id) rn FROM target_private.active_gacha_receipts(NULL) r
  ),eligible AS(
    SELECT member_id,request_id,item_type,item_id FROM ranked r
    WHERE rn>1 AND r.cost-target_private.receipt_financial_refund_amount(r.member_id,r.request_id)>=10000
  ),credited AS(
    INSERT INTO target_private.duplicate_rebates(member_id,request_id,item_type,item_id,source)
    SELECT member_id,request_id,item_type,item_id,'historical' FROM eligible
      ON CONFLICT(member_id,request_id) DO NOTHING RETURNING member_id,amount
  ),per_member AS(
    SELECT member_id,sum(amount)::bigint rebate FROM credited GROUP BY member_id
  ),applied AS(
    UPDATE target_private.profiles p SET spent_points=p.spent_points-v.rebate,updated_at=now()
      FROM per_member v
      WHERE p.member_id=v.member_id AND p.spent_points>=v.rebate
        AND p.wallet_revision<10000000000000
      RETURNING p.member_id,v.rebate
  )
  SELECT (SELECT count(*) FROM credited),(SELECT count(*) FROM per_member),
    (SELECT count(*) FROM applied),coalesce((SELECT sum(amount) FROM credited),0)::bigint
    INTO credited_count,member_count,applied_count,credit_total;
  IF applied_count<>member_count THEN
    RAISE EXCEPTION 'Duplicate rebate cannot be safely credited to all wallets' USING ERRCODE='23514';
  END IF;
  IF credited_count>0 THEN
    UPDATE target_private.system_state SET logical_bytes=logical_bytes+credited_count*256
      WHERE singleton AND logical_bytes+credited_count*256<=104857600;
    IF NOT FOUND THEN RAISE EXCEPTION 'Duplicate rebate storage capacity exceeded' USING ERRCODE='54000'; END IF;
  END IF;
  IF EXISTS(
    SELECT 1 FROM target_private.wallet_finance_projection(NULL) calc
      JOIN target_private.profiles live USING(member_id)
    WHERE (calc.total_points,calc.spent_points,calc.calculus_points,calc.birthday_points,calc.casino_net,calc.calculus_forgiven_points)
      IS DISTINCT FROM (live.total_points,live.spent_points,live.calculus_points,live.birthday_points,live.casino_net,live.calculus_forgiven_points)
  ) THEN
    RAISE EXCEPTION 'Duplicate rebates must reconcile with permanent wallet histories' USING ERRCODE='23514';
  END IF;
  RAISE NOTICE 'Duplicate rebate credit rows: %, people: %, points: %',credited_count,member_count,credit_total;
END $backfill$;
