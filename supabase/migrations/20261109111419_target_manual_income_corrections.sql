-- Mechanism only. The operator supplies an explicitly authorized manifest;
-- this migration does not select or change any user's financial values.
BEGIN;
SELECT pg_advisory_xact_lock(991101);
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
      IS DISTINCT FROM '049a8d9c1d86e1b9c8f77f65f82ddbb3' OR
     (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_state(target_private.profiles)'::regprocedure)
      IS DISTINCT FROM 'bc5164b65cd12933819abf9e28f13e3b' OR
     (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_snapshot(uuid)'::regprocedure)
      IS DISTINCT FROM '81d64c6af84c5f9ead267bea4753cec1' THEN
    RAISE EXCEPTION 'Financial accounting changed; review the manual income correction again';
  END IF;
END $guard$;

CREATE FUNCTION target_private.adjust_wallet_income(p_operation_id text,p_manifest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  canonical jsonb; manifest_sha text; item jsonb; p target_private.profiles%rowtype;
  existing target_private.wallet_restoration_events%rowtype;
  before_snapshot jsonb; before_state jsonb; after_state jsonb; delta jsonb;
  applied_at timestamptz; members integer; desired bigint; amount bigint; next_casino bigint;
  audit_bytes bigint;
BEGIN
  IF p_operation_id IS NULL OR p_operation_id!~'^income_adjust_[a-zA-Z0-9_-]{1,66}$' OR
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
        AND component_deltas->'incomeCorrection'->>'kind' IS DISTINCT FROM 'authorized_income_adjustment_v1') THEN
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
  -- helper deliberately has no spending refund or balance-forgiveness option.
  FOR item IN SELECT value FROM jsonb_array_elements(canonical->'targets') LOOP
    SELECT * INTO STRICT p FROM target_private.profiles WHERE member_id=(item->>'memberId')::uuid FOR UPDATE;
    desired:=(item->>'totalIncome')::bigint; amount:=desired-p.total_points; next_casino:=p.casino_net+amount;
    IF p.name<>item->>'expectedName' THEN
      RAISE EXCEPTION 'Income correction member name changed' USING ERRCODE='23514';
    END IF;
    IF desired<p.spent_points THEN
      RAISE EXCEPTION 'Income cannot be reduced below already recorded spending' USING ERRCODE='23514';
    END IF;
    IF next_casino NOT BETWEEN -10000000000000 AND 10000000000000 OR next_casino%10<>0 OR
      p.wallet_revision>=10000000000000 THEN
      RAISE EXCEPTION 'Income correction would exceed financial component bounds' USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT jsonb_object_agg(live_profile.member_id::text,target_private.wallet_finance_state(live_profile)) INTO before_snapshot
    FROM target_private.profiles live_profile JOIN jsonb_array_elements(canonical->'targets') t
      ON live_profile.member_id=(t->>'memberId')::uuid;
  audit_bytes:=1024+members*4096;
  UPDATE target_private.system_state SET logical_bytes=logical_bytes+audit_bytes
    WHERE singleton AND logical_bytes<=104857600-audit_bytes;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Income correction audit exceeds storage capacity' USING ERRCODE='54000';
  END IF;
  applied_at:=clock_timestamp();
  -- This is the true correction time, not a fabricated historical cutoff. The
  -- empty interval cannot claim that an old purchase has been refunded.
  INSERT INTO target_private.wallet_restoration_events(reset_id,cutoff_at,prepared_at,source_manifest_sha256,
    before_snapshot_sha256,member_count) VALUES(p_operation_id,applied_at,applied_at,manifest_sha,
      encode(sha256(convert_to(before_snapshot::text,'UTF8')),'hex'),members);
  FOR item IN SELECT value FROM jsonb_array_elements(canonical->'targets') LOOP
    SELECT * INTO STRICT p FROM target_private.profiles WHERE member_id=(item->>'memberId')::uuid;
    before_state:=before_snapshot->p.member_id::text;
    desired:=(item->>'totalIncome')::bigint; amount:=desired-p.total_points;
    -- casino_net is the existing signed non-study correction component. Record
    -- an explicit operator correction; never invent or rewrite a game receipt.
    UPDATE target_private.profiles SET total_points=desired,casino_net=casino_net+amount,updated_at=now()
      WHERE member_id=p.member_id RETURNING target_private.wallet_finance_state(profiles) INTO after_state;
    delta:=jsonb_build_object('totalPoints',amount,'spentPoints',0,'calculusPoints',0,'birthdayPoints',0,
      'casinoNet',amount,'calculusForgivenPoints',0,'rawStudyPoints',0,
      'incomeCorrection',jsonb_build_object('kind','authorized_income_adjustment_v1','version',1,
        'reason',canonical->>'reason','memberId',item->>'memberId','expectedName',item->>'expectedName',
        'totalIncome',desired,'spendingPolicy','preserve'));
    INSERT INTO target_private.wallet_restorations(reset_id,member_id,before_state,after_void_state,restored_state,
      component_deltas,spent_refund) VALUES(p_operation_id,p.member_id,before_state,before_state,after_state,delta,0);
  END LOOP;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles live_profile USING(member_id)
    WHERE (live_profile.total_points,live_profile.spent_points,live_profile.calculus_points,live_profile.birthday_points,live_profile.casino_net,live_profile.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Income correction does not reconcile with the permanent ledger' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('operationId',p_operation_id,'members',members,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION target_private.adjust_wallet_income(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
