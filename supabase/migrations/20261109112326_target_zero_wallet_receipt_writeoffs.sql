-- Mechanism only. No account IDs or financial operations are embedded here.
-- An explicitly authorized zero-wallet correction keeps the actual item rows,
-- and attributes every spending write-off to immutable modern purchase receipts.
BEGIN;
SELECT pg_advisory_xact_lock(991101);
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
      IS DISTINCT FROM '049a8d9c1d86e1b9c8f77f65f82ddbb3' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_snapshot(uuid)'::regprocedure)
      IS DISTINCT FROM '81d64c6af84c5f9ead267bea4753cec1' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.restore_inventory(text,timestamptz,text)'::regprocedure)
      IS DISTINCT FROM 'ee3dbf933ea4f70b810888ee243db35f' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.validate_inventory_void()'::regprocedure)
      IS DISTINCT FROM '84f09d151f063ffdedf98fae6cdbbe34' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.receipt_wallet_refund(uuid,uuid)'::regprocedure)
      IS DISTINCT FROM 'b30ce932ce19dc5735819296d0d2a8dc' THEN
    RAISE EXCEPTION 'Financial accounting changed; review the receipt write-off migration again';
  END IF;
END $guard$;

CREATE TABLE target_private.manual_receipt_writeoffs (
  reset_id text NOT NULL CHECK(reset_id~'^zero_income_[a-zA-Z0-9_-]{1,68}$'),
  member_id uuid NOT NULL,
  request_id uuid NOT NULL,
  amount integer NOT NULL CHECK(amount BETWEEN 100 AND 100000 AND amount%100=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
  PRIMARY KEY(reset_id,member_id,request_id),
  FOREIGN KEY(reset_id,member_id) REFERENCES target_private.wallet_restorations(reset_id,member_id),
  FOREIGN KEY(member_id,request_id) REFERENCES target_private.item_draws(member_id,request_id)
);
CREATE INDEX manual_receipt_writeoffs_receipt ON target_private.manual_receipt_writeoffs(member_id,request_id);
ALTER TABLE target_private.manual_receipt_writeoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE target_private.manual_receipt_writeoffs FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER manual_receipt_writeoff_permanent BEFORE UPDATE OR DELETE ON target_private.manual_receipt_writeoffs
  FOR EACH ROW EXECUTE FUNCTION target_private.protect_wallet_restoration();

CREATE FUNCTION target_private.validate_manual_receipt_writeoff()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
      WHERE w.member_id=NEW.member_id AND w.request_id=NEW.request_id),0)>receipt.cost OR
    NEW.amount+coalesce((SELECT sum(w.amount) FROM target_private.manual_receipt_writeoffs w
      WHERE w.reset_id=NEW.reset_id AND w.member_id=NEW.member_id),0)>operation.spent_refund THEN
    RAISE EXCEPTION 'Manual spending write-off does not match an active unrefunded purchase' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION target_private.validate_manual_receipt_writeoff() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER manual_receipt_writeoff_valid BEFORE INSERT ON target_private.manual_receipt_writeoffs
  FOR EACH ROW EXECUTE FUNCTION target_private.validate_manual_receipt_writeoff();

-- Receipt-level financial refund attribution, including partial write-offs.
CREATE FUNCTION target_private.receipt_financial_refund_amount(p_member uuid,p_request uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT CASE WHEN target_private.receipt_wallet_refund(p_member,p_request) IS NOT NULL THEN d.cost::bigint
    ELSE coalesce((SELECT sum(w.amount)::bigint FROM target_private.manual_receipt_writeoffs w
      WHERE w.member_id=p_member AND w.request_id=p_request),0) END
  FROM target_private.gacha_receipts(p_member) d WHERE d.request_id=p_request;
$$;
CREATE FUNCTION target_private.receipt_financial_refund_event(p_member uuid,p_request uuid)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(target_private.receipt_wallet_refund(p_member,p_request),(
    SELECT w.reset_id FROM target_private.manual_receipt_writeoffs w
      JOIN target_private.wallet_restoration_events e USING(reset_id)
      WHERE w.member_id=p_member AND w.request_id=p_request
      ORDER BY e.created_at,w.reset_id LIMIT 1));
$$;
CREATE FUNCTION target_private.assert_receipt_refund_coverage(p_member uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  IF EXISTS(SELECT 1 FROM target_private.manual_receipt_writeoffs w
      JOIN target_private.item_draws d USING(member_id,request_id)
      WHERE w.member_id=p_member GROUP BY w.member_id,w.request_id,d.cost HAVING sum(w.amount)>d.cost) OR
    coalesce((SELECT sum(r.spent_refund) FROM target_private.wallet_restorations r WHERE r.member_id=p_member),0)
    <>coalesce((SELECT sum(target_private.receipt_financial_refund_amount(d.member_id,d.request_id))
      FROM target_private.gacha_receipts(p_member) d),0) THEN
    RAISE EXCEPTION 'Financial refund coverage does not match exact receipt amounts' USING ERRCODE='23514';
  END IF;
END $$;
CREATE FUNCTION target_private.check_receipt_refund_coverage()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM target_private.manual_receipt_writeoffs WHERE member_id=NEW.member_id) THEN
    PERFORM target_private.assert_receipt_refund_coverage(NEW.member_id);
  END IF;
  RETURN NEW;
END $$;
-- Deferred checks see the complete operator operation. They also fence a
-- financial-restoration body already compiled before the schema cutover.
CREATE CONSTRAINT TRIGGER wallet_restoration_receipt_coverage
  AFTER INSERT ON target_private.wallet_restorations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION target_private.check_receipt_refund_coverage();
CREATE CONSTRAINT TRIGGER manual_writeoff_receipt_coverage
  AFTER INSERT ON target_private.manual_receipt_writeoffs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION target_private.check_receipt_refund_coverage();

-- Widen only the three refund amount grids and the old binary void rule.
-- All purchase identity, time, immutable history and state-delta checks remain.
DO $refund_checks$
DECLARE entry record; found_count integer;
BEGIN
  found_count:=0;
  FOR entry IN SELECT conname FROM pg_constraint
    WHERE conrelid='target_private.inventory_voids'::regclass AND contype='c'
      AND position('additional_refund' IN pg_get_constraintdef(oid))>0 LOOP
    EXECUTE format('ALTER TABLE target_private.inventory_voids DROP CONSTRAINT %I',entry.conname);
    found_count:=found_count+1;
  END LOOP;
  IF found_count<>2 THEN RAISE EXCEPTION 'Unexpected inventory void refund checks'; END IF;
  found_count:=0;
  FOR entry IN SELECT conname FROM pg_constraint
    WHERE conrelid='target_private.inventory_restoration_events'::regclass AND contype='c'
      AND position('additional_refund' IN pg_get_constraintdef(oid))>0
      AND position('100000' IN pg_get_constraintdef(oid))>0 LOOP
    EXECUTE format('ALTER TABLE target_private.inventory_restoration_events DROP CONSTRAINT %I',entry.conname);
    found_count:=found_count+1;
  END LOOP;
  IF found_count<>1 THEN RAISE EXCEPTION 'Unexpected inventory event refund grid'; END IF;
  found_count:=0;
  FOR entry IN SELECT conname FROM pg_constraint
    WHERE conrelid='target_private.inventory_restorations'::regclass AND contype='c'
      AND position('additional_refund' IN pg_get_constraintdef(oid))>0
      AND position('100000' IN pg_get_constraintdef(oid))>0 LOOP
    EXECUTE format('ALTER TABLE target_private.inventory_restorations DROP CONSTRAINT %I',entry.conname);
    found_count:=found_count+1;
  END LOOP;
  IF found_count<>1 THEN RAISE EXCEPTION 'Unexpected inventory member refund grid'; END IF;
END $refund_checks$;
ALTER TABLE target_private.inventory_voids ADD CONSTRAINT inventory_void_refund_amount
  CHECK(additional_refund BETWEEN 0 AND cost AND additional_refund%100=0);
ALTER TABLE target_private.inventory_restoration_events ADD CONSTRAINT inventory_event_refund_amount
  CHECK(additional_refund BETWEEN 0 AND 10000000000000 AND additional_refund%100=0);
ALTER TABLE target_private.inventory_restorations ADD CONSTRAINT inventory_member_refund_amount
  CHECK(additional_refund BETWEEN 0 AND 10000000000000 AND additional_refund%100=0);

CREATE OR REPLACE FUNCTION target_private.validate_inventory_void()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE d target_private.item_draws%rowtype; refunded bigint; refund_event text;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  SELECT * INTO STRICT d FROM target_private.item_draws WHERE member_id=NEW.member_id AND request_id=NEW.request_id;
  IF (NEW.item_type,NEW.item_id,NEW.cost,NEW.drawn_at) IS DISTINCT FROM
      (d.item_type,coalesce(d.sticker_id,d.frame_id),d.cost,d.created_at) THEN
    RAISE EXCEPTION 'Inventory tombstone does not match its immutable purchase' USING ERRCODE='23514';
  END IF;
  refunded:=target_private.receipt_financial_refund_amount(NEW.member_id,NEW.request_id);
  refund_event:=target_private.receipt_financial_refund_event(NEW.member_id,NEW.request_id);
  IF refunded IS NULL OR refunded NOT BETWEEN 0 AND d.cost OR refunded%100<>0 OR
      NEW.wallet_refund_reset_id IS DISTINCT FROM refund_event OR
      NEW.additional_refund IS DISTINCT FROM d.cost-refunded THEN
    RAISE EXCEPTION 'Inventory refund must equal the exact receipt residual and proof event' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DO $inventory_residuals$
DECLARE definition text; old_values text[]; new_values text[]; i integer;
BEGIN
  SELECT pg_get_functiondef('target_private.restore_inventory(text,timestamptz,text)'::regprocedure) INTO definition;
  old_values:=ARRAY[
    $old$coalesce((SELECT sum(r.cost) FROM target_private.gacha_receipts(a.member_id) r
      WHERE target_private.receipt_wallet_refund(r.member_id,r.request_id) IS NOT NULL),0)$old$,
    $old$CASE WHEN target_private.receipt_wallet_refund(d.member_id,d.request_id) IS NULL THEN d.cost ELSE 0 END$old$,
    $old$coalesce((SELECT sum(d.cost) FROM target_private.item_draws d WHERE d.member_id=a.member_id AND d.created_at>=p_cutoff
      AND target_private.receipt_wallet_refund(d.member_id,d.request_id) IS NULL
      AND NOT EXISTS(SELECT 1 FROM target_private.inventory_voids v WHERE v.member_id=d.member_id AND v.request_id=d.request_id)),0)$old$,
    $old$proof.reset_id,CASE WHEN proof.reset_id IS NULL THEN draw_value.cost ELSE 0 END
      FROM(SELECT target_private.receipt_wallet_refund(draw_value.member_id,draw_value.request_id) reset_id) proof;$old$
  ];
  new_values:=ARRAY[
    $new$coalesce((SELECT sum(target_private.receipt_financial_refund_amount(r.member_id,r.request_id))
      FROM target_private.gacha_receipts(a.member_id) r),0)$new$,
    $new$d.cost-target_private.receipt_financial_refund_amount(d.member_id,d.request_id)$new$,
    $new$coalesce((SELECT sum(d.cost-target_private.receipt_financial_refund_amount(d.member_id,d.request_id))
      FROM target_private.item_draws d WHERE d.member_id=a.member_id AND d.created_at>=p_cutoff
      AND NOT EXISTS(SELECT 1 FROM target_private.inventory_voids v WHERE v.member_id=d.member_id AND v.request_id=d.request_id)),0)$new$,
    $new$proof.reset_id,draw_value.cost-target_private.receipt_financial_refund_amount(draw_value.member_id,draw_value.request_id)
      FROM(SELECT target_private.receipt_financial_refund_event(draw_value.member_id,draw_value.request_id) reset_id) proof;$new$
  ];
  FOR i IN 1..array_length(old_values,1) LOOP
    IF (length(definition)-length(replace(definition,old_values[i],'')))/length(old_values[i])<>1 THEN
      RAISE EXCEPTION 'Inventory residual adaptation did not match branch %',i;
    END IF;
    definition:=replace(definition,old_values[i],new_values[i]);
  END LOOP;
  EXECUTE definition;
END $inventory_residuals$;
REVOKE ALL ON FUNCTION target_private.receipt_financial_refund_amount(uuid,uuid),
  target_private.receipt_financial_refund_event(uuid,uuid),target_private.assert_receipt_refund_coverage(uuid),
  target_private.check_receipt_refund_coverage(),target_private.validate_inventory_void()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION target_private.zero_wallet_income(p_operation_id text,p_manifest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
        WHERE w.member_id=d.member_id AND w.request_id=d.request_id),0) AS available
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
END $$;
REVOKE ALL ON FUNCTION target_private.zero_wallet_income(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
