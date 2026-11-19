-- Strict read-only verification of the completed, receipt-funded retirement.
BEGIN READ ONLY;
DO $verify$
DECLARE operation_id constant text:='sticker_retire_20261110_v1';
  e target_private.inventory_restoration_events%rowtype;
  expected record; relation text; role_name text; w jsonb;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.target_shop_rpc(text,text,jsonb)','d2894029cd0197665d00872782e89c0a'),
    ('target_private.wallet_snapshot(uuid)','be7df0a8b178ddd89df59537d76dc705'),
    ('target_private.retire_stickers(text)','368794e00a05c9d708ae9bf39de89cad'),
    ('target_private.stickers_retired()','db7f41f5b602350ad1fde9ba99c6a1da'),
    ('target_private.validate_inventory_void()','dcd990ca7f6946fb36db7b71ce226e18'),
    ('target_private.enforce_gacha_catalog_protocol()','c83db9384d1506371b76b6bc05a73093'),
    ('target_private.enforce_active_gacha_protocol()','c1489b31c75e7805d806e0b80b25617b'),
    ('target_private.active_gacha_receipts(uuid)','ed686b7d29e92c061324993f0c3289e9'),
    ('target_private.receipt_financial_refund_amount(uuid,uuid)','4ea290fe93fbf2cdd903a0ead8926953'),
    ('target_private.receipt_financial_refund_event(uuid,uuid)','002f6d82596f19f7e5df072b6f7c18a0'),
    ('public.two_player_rpc(text,text,jsonb)','a31ef2f093dc1dc3204cd9683047c17d')
  ) v(signature,hash) LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure) IS DISTINCT FROM expected.hash AND NOT
      (expected.signature='public.two_player_rpc(text,text,jsonb)' AND
        (SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure)='07bd70771529b5749c49810f8feb2f08') THEN
      RAISE EXCEPTION 'Reviewed retirement or unchanged financial boundary differs: %',expected.signature; END IF;
  END LOOP;
  SELECT * INTO STRICT e FROM target_private.inventory_restoration_events WHERE reset_id=operation_id;
  IF NOT target_private.stickers_retired() OR e.base_wallet_reset_id IS NOT NULL OR e.cutoff_at<>e.prepared_at OR
    e.member_count<>(SELECT count(*) FROM target_private.inventory_restorations WHERE reset_id=operation_id) OR
    e.voided_draw_count<>(SELECT count(*) FROM target_private.inventory_voids WHERE reset_id=operation_id) OR
    e.additional_refund<>(SELECT coalesce(sum(additional_refund),0) FROM target_private.inventory_restorations WHERE reset_id=operation_id) OR
    e.additional_refund<>(SELECT coalesce(sum(additional_refund),0) FROM target_private.inventory_voids WHERE reset_id=operation_id) OR
    e.before_inventory_sha256<>(SELECT encode(sha256(convert_to(coalesce(jsonb_object_agg(member_id::text,before_state),'{}'::jsonb)::text,'UTF8')),'hex')
      FROM target_private.inventory_restorations WHERE reset_id=operation_id) THEN
    RAISE EXCEPTION 'Sticker retirement event and audit receipts disagree'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.inventory_voids v LEFT JOIN target_private.gacha_receipts(NULL) d USING(member_id,request_id)
    WHERE v.reset_id=operation_id AND (d.member_id IS NULL OR v.item_type<>'sticker' OR
      (v.item_type,v.item_id,v.cost,v.drawn_at) IS DISTINCT FROM (d.item_type,d.item_id,d.cost,d.drawn_at) OR
      v.additional_refund IS DISTINCT FROM d.cost-target_private.receipt_financial_refund_amount(v.member_id,v.request_id) OR
      v.wallet_refund_reset_id IS DISTINCT FROM target_private.receipt_financial_refund_event(v.member_id,v.request_id))) THEN
    RAISE EXCEPTION 'Sticker refund is not the exact remaining immutable receipt cost'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.inventory_restorations r WHERE reset_id=operation_id AND (
    r.voided_draw_count<>(SELECT count(*) FROM target_private.inventory_voids v WHERE v.reset_id=operation_id AND v.member_id=r.member_id) OR
    r.additional_refund<>(SELECT coalesce(sum(additional_refund),0) FROM target_private.inventory_voids v WHERE v.reset_id=operation_id AND v.member_id=r.member_id) OR
    (r.restored_state->>'totalIncome')::bigint<>(r.before_state->>'totalIncome')::bigint OR
    (r.restored_state->>'balance')::bigint-(r.before_state->>'balance')::bigint<>r.additional_refund OR
    (r.before_state->>'spent')::bigint-(r.restored_state->>'spent')::bigint<>r.additional_refund OR
    (r.restored_state->>'walletRevision')::bigint<>(r.before_state->>'walletRevision')::bigint+1 OR
    r.restored_state->'ownedFrames' IS DISTINCT FROM r.before_state->'ownedFrames' OR
    r.restored_state->'frameQuantities' IS DISTINCT FROM r.before_state->'frameQuantities' OR
    r.restored_state->'drawCount' IS DISTINCT FROM r.before_state->'drawCount' OR
    r.restored_state->'legacyDiscountedDraws' IS DISTINCT FROM r.before_state->'legacyDiscountedDraws' OR
    r.restored_state->'ownedStickers'<>'[]'::jsonb OR r.restored_state->'stickerQuantities'<>'[]'::jsonb OR
    r.restored_state->'catalogVersion'<>'4'::jsonb OR r.restored_state->'catalogSize'<>'0'::jsonb OR
    r.restored_state->'stickersRetired' IS DISTINCT FROM 'true'::jsonb)) THEN
    RAISE EXCEPTION 'Sticker retirement changed income or frames, or returned a wrong spending delta'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.active_gacha_receipts(NULL) WHERE item_type='sticker') THEN
    RAISE EXCEPTION 'An old sticker still has active ownership'; END IF;
  FOR expected IN SELECT member_id FROM target_private.profiles LOOP
    w:=target_private.wallet_snapshot(expected.member_id);
    IF w->'catalogVersion'<>'4'::jsonb OR w->'catalogSize'<>'0'::jsonb OR w->'stickersRetired' IS DISTINCT FROM 'true'::jsonb OR
      w->'ownedStickers'<>'[]'::jsonb OR w->'stickerQuantities'<>'[]'::jsonb OR
      (w->>'drawCount')::bigint-coalesce((w->>'voidedDrawCount')::bigint,0)<>(
        SELECT count(*) FROM target_private.active_gacha_receipts(expected.member_id) WHERE item_type='frame') OR
      (w->>'spent')::bigint+coalesce((w->>'refundedSpend')::bigint,0)<>
        (w->>'drawCount')::bigint*100000-(w->>'legacyDiscountedDraws')::bigint*90000+coalesce((w->>'mapSpent')::bigint,0) THEN
      RAISE EXCEPTION 'Retired inventory and historical cost proof disagree'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
      IS DISTINCT FROM '8e69577732c1f54b2dae637b87aa3fd6' THEN
    RAISE EXCEPTION 'Financial projection changed or no longer reconciles'; END IF;
  FOREACH relation IN ARRAY ARRAY['inventory_restoration_events','inventory_voids','inventory_restorations','sticker_draws','item_draws'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('target_private.'||relation)::regclass) THEN
      RAISE EXCEPTION 'Receipt history is not protected with RLS'; END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(role_name,'target_private.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'API role can access private receipt history'; END IF;
    END LOOP;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_function_privilege(role_name,'target_private.retire_stickers(text)','EXECUTE') OR
      has_function_privilege(role_name,'target_private.stickers_retired()','EXECUTE') OR
      has_function_privilege(role_name,'target_private.validate_inventory_void()','EXECUTE') OR
      has_function_privilege(role_name,'target_private.enforce_gacha_catalog_protocol()','EXECUTE') THEN
      RAISE EXCEPTION 'API role can bypass the retirement boundary'; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.inventory_restoration_events'::regclass
    AND conname='inventory_retirement_base' AND convalidated) OR
    NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.inventory_voids'::regclass
    AND conname='inventory_void_receipt_cost' AND convalidated) THEN
    RAISE EXCEPTION 'Retirement event or immutable receipt cost bounds are missing'; END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('inventory_restoration_events','inventory_restoration_event_permanent'),
    ('inventory_voids','inventory_void_permanent'),('inventory_voids','inventory_void_receipt'),
    ('inventory_restorations','inventory_restoration_permanent'),
    ('sticker_draws','target_legacy_receipt_immutable'),('item_draws','target_item_receipt_immutable'),
    ('item_draws','target_item_catalog_protocol')
  ) v(relation,trigger_name) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('target_private.'||expected.relation)::regclass
      AND tgname=expected.trigger_name AND NOT tgisinternal AND tgenabled='O') THEN
      RAISE EXCEPTION 'Permanent receipt or purchase fence trigger missing: %',expected.trigger_name; END IF;
  END LOOP;
END $verify$;
SELECT 'target_sticker_retirement_postflight_passed' AS result;
ROLLBACK;
