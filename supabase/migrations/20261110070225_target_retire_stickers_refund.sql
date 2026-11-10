-- Generated with Supabase CLI 3.1.0 migration new target_retire_stickers_refund.
-- Explicit user-authorized retirement: original receipts and income remain;
-- only still-paid sticker costs are returned by reducing recorded spending.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
SELECT 1 FROM target_private.system_state WHERE singleton FOR UPDATE;
LOCK TABLE target_private.profiles IN SHARE ROW EXCLUSIVE MODE;
DO $guard$
DECLARE expected record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.target_shop_rpc(text,text,jsonb)','222fca72fbfefb686da11d6ac43445a9'),
    ('target_private.wallet_snapshot(uuid)','81d64c6af84c5f9ead267bea4753cec1'),
    ('target_private.wallet_finance_projection(timestamptz)','8e69577732c1f54b2dae637b87aa3fd6'),
    ('target_private.validate_inventory_void()','57deb9ff2664dd9e58d6121da538aa6e'),
    ('target_private.enforce_gacha_catalog_protocol()','11643d7dc1035dd97dfa1c056b983857'),
    ('target_private.receipt_financial_refund_amount(uuid,uuid)','4ea290fe93fbf2cdd903a0ead8926953'),
    ('target_private.receipt_financial_refund_event(uuid,uuid)','002f6d82596f19f7e5df072b6f7c18a0'),
    ('target_private.active_gacha_receipts(uuid)','ed686b7d29e92c061324993f0c3289e9')
  ) v(signature,hash) LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure) IS DISTINCT FROM expected.hash THEN
      RAISE EXCEPTION 'Reviewed sticker accounting boundary changed: %',expected.signature; END IF;
  END LOOP;
END $guard$;

-- A retirement does not invent an unrelated financial-restoration event.
-- Historical restoration rows keep their mandatory base; only this explicit
-- simultaneous current-time retirement may have no financial-restoration base.
ALTER TABLE target_private.inventory_restoration_events
  ALTER COLUMN base_wallet_reset_id DROP NOT NULL,
  ADD CONSTRAINT inventory_retirement_base CHECK(base_wallet_reset_id IS NOT NULL OR
    (reset_id='sticker_retire_20261110_v1' AND cutoff_at=prepared_at));
DO $legacy_receipts$
DECLARE entry record; found_count integer:=0;
BEGIN
  FOR entry IN SELECT conname FROM pg_constraint
    WHERE conrelid='target_private.inventory_voids'::regclass AND contype='f'
      AND confrelid='target_private.item_draws'::regclass LOOP
    EXECUTE format('ALTER TABLE target_private.inventory_voids DROP CONSTRAINT %I',entry.conname);
    found_count:=found_count+1;
  END LOOP;
  IF found_count<>1 THEN RAISE EXCEPTION 'Unexpected inventory receipt identity constraint'; END IF;
  found_count:=0;
  FOR entry IN SELECT conname FROM pg_constraint
    WHERE conrelid='target_private.inventory_voids'::regclass AND contype='c'
      AND position('cost' IN pg_get_constraintdef(oid))>0
      AND position('additional_refund' IN pg_get_constraintdef(oid))=0 LOOP
    EXECUTE format('ALTER TABLE target_private.inventory_voids DROP CONSTRAINT %I',entry.conname);
    found_count:=found_count+1;
  END LOOP;
  IF found_count<>1 THEN RAISE EXCEPTION 'Unexpected inventory historical cost constraint'; END IF;
END $legacy_receipts$;
ALTER TABLE target_private.inventory_voids ADD CONSTRAINT inventory_void_receipt_cost
  CHECK(cost=100000 OR (cost=10000 AND item_type='sticker'));

-- Both purchase tables are immutable. Exact union identity, cost, timestamp and
-- canonical financial coverage replace the narrower modern-only foreign key.
CREATE OR REPLACE FUNCTION target_private.validate_inventory_void()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
  refunded:=target_private.receipt_financial_refund_amount(NEW.member_id,NEW.request_id);
  refund_event:=target_private.receipt_financial_refund_event(NEW.member_id,NEW.request_id);
  IF refunded IS NULL OR refunded NOT BETWEEN 0 AND d.cost OR refunded%100<>0 OR
      NEW.wallet_refund_reset_id IS DISTINCT FROM refund_event OR
      NEW.additional_refund IS DISTINCT FROM d.cost-refunded THEN
    RAISE EXCEPTION 'Inventory refund must equal the exact receipt residual and proof event' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION target_private.stickers_retired()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM target_private.inventory_restoration_events
    WHERE reset_id='sticker_retire_20261110_v1' AND base_wallet_reset_id IS NULL AND cutoff_at=prepared_at);
$$;
CREATE OR REPLACE FUNCTION target_private.enforce_gacha_catalog_protocol()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='sticker_draws' THEN
    RAISE EXCEPTION 'Legacy sticker purchases are permanently retired' USING ERRCODE='42501'; END IF;
  IF (target_private.stickers_retired() AND NEW.item_type='sticker') OR
      current_setting('target.gacha_catalog_protocol',true) IS DISTINCT FROM
        (CASE WHEN target_private.stickers_retired() THEN '4' ELSE '3' END) OR
      current_setting('target.gacha_price_protocol',true) IS DISTINCT FROM '100000' THEN
    RAISE EXCEPTION 'Current active-item gacha protocol required' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM target_private.sticker_draws d WHERE d.member_id=NEW.member_id AND d.request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'Historical request identifier is already used' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END $$;

DO $wallet_and_shop$
DECLARE definition text; marker text; replacement text; expected_count integer;
BEGIN
  SELECT pg_get_functiondef('target_private.wallet_snapshot(uuid)'::regprocedure) INTO definition;
  marker:='''catalogVersion'',3,''catalogSize'',17';
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
    RAISE EXCEPTION 'Reviewed catalog wallet marker changed'; END IF;
  definition:=replace(definition,marker,
    '''catalogVersion'',CASE WHEN target_private.stickers_retired() THEN 4 ELSE 3 END,''catalogSize'',CASE WHEN target_private.stickers_retired() THEN 0 ELSE 17 END');
  marker:='FROM target_private.profiles p CROSS JOIN refunds CROSS JOIN voids WHERE p.member_id=p_member;';
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
    RAISE EXCEPTION 'Reviewed wallet metadata marker changed'; END IF;
  definition:=replace(definition,marker,
    '||CASE WHEN target_private.stickers_retired() THEN jsonb_build_object(''stickersRetired'',true) ELSE ''{}''::jsonb END'||chr(10)||'  '||marker);
  EXECUTE definition;
  SELECT pg_get_functiondef('public.target_shop_rpc(text,text,jsonb)'::regprocedure) INTO definition;
  FOR marker,replacement,expected_count IN SELECT * FROM (VALUES
    ('''1''::jsonb,''2''::jsonb,''3''::jsonb','''1''::jsonb,''2''::jsonb,''3''::jsonb,''4''::jsonb',1),
    ('PERFORM pg_advisory_xact_lock(991101);',
      'PERFORM pg_advisory_xact_lock(991101);'||chr(10)||
      '  IF p_action=''draw'' AND pool_kind=''sticker'' AND target_private.stickers_retired() AND NOT EXISTS('||chr(10)||
      '    SELECT 1 FROM target_private.gacha_receipts(member_uuid) WHERE request_id=(p_input->>''requestId'')::uuid) THEN'||chr(10)||
      '    RETURN target_private.error_result(410,''STICKERS_RETIRED'',''スタンプは現在利用できません。''); END IF;',1),
    ('coalesce((p_input->>''expectedCatalogVersion'')::integer,1)<>3',
      'coalesce((p_input->>''expectedCatalogVersion'')::integer,1)<>(CASE WHEN target_private.stickers_retired() THEN 4 ELSE 3 END)',1),
    ('PERFORM set_config(''target.gacha_catalog_protocol'',''3'',true);',
      'PERFORM set_config(''target.gacha_catalog_protocol'',CASE WHEN target_private.stickers_retired() THEN ''4'' ELSE ''3'' END,true);',1),
    ('''stickerId'',saved_legacy.sticker_id,''cost'',saved_legacy.cost,''quantity'',quantity);',
      '''stickerId'',saved_legacy.sticker_id,''cost'',saved_legacy.cost,''quantity'',quantity)||'||chr(10)||
      '      CASE WHEN EXISTS(SELECT 1 FROM target_private.inventory_voids WHERE member_id=member_uuid AND request_id=request_uuid)'||chr(10)||
      '      THEN jsonb_build_object(''receiptVoided'',true) ELSE ''{}''::jsonb END;',1)
  ) changes(old_value,new_value,count_value) LOOP
    IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>expected_count THEN
      RAISE EXCEPTION 'Reviewed sticker shop marker changed: %',marker; END IF;
    definition:=replace(definition,marker,replacement);
  END LOOP;
  EXECUTE definition;
END $wallet_and_shop$;

CREATE FUNCTION target_private.retire_stickers(p_reset_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
      'refundedAmount',d.cost-target_private.receipt_financial_refund_amount(d.member_id,d.request_id),
      'financialEvent',target_private.receipt_financial_refund_event(d.member_id,d.request_id))
      ORDER BY d.member_id,d.drawn_at,d.request_id),'[]'::jsonb),count(*)::integer,
      count(DISTINCT d.member_id)::integer,
      coalesce(sum(d.cost-target_private.receipt_financial_refund_amount(d.member_id,d.request_id)),0)::bigint
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
END $$;
REVOKE ALL ON FUNCTION target_private.stickers_retired(),target_private.retire_stickers(text),
  target_private.validate_inventory_void(),target_private.enforce_gacha_catalog_protocol(),target_private.wallet_snapshot(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- The reviewed schema, purchase fence, refund and public v4 inventory metadata
-- become visible together. No real account IDs or quoted balances are embedded.
SELECT target_private.retire_stickers('sticker_retire_20261110_v1') AS retirement;
COMMIT;
