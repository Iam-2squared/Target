-- Generated with Supabase CLI 3.1.0 migration new target_photo_sticker_catalog.
-- Adds a distinct active photo catalog. Existing retirement refunds and every
-- immutable receipt stay intact; no member balances or ownership are granted.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
SELECT 1 FROM target_private.system_state WHERE singleton FOR UPDATE;
DO $guard$
DECLARE entry record;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('public.target_shop_rpc(text,text,jsonb)','d2894029cd0197665d00872782e89c0a'),
    ('target_private.wallet_snapshot(uuid)','be7df0a8b178ddd89df59537d76dc705'),
    ('target_private.enforce_gacha_catalog_protocol()','c83db9384d1506371b76b6bc05a73093'),
    ('target_private.stickers_retired()','db7f41f5b602350ad1fde9ba99c6a1da'),
    ('target_private.wallet_finance_projection(timestamptz)','8e69577732c1f54b2dae637b87aa3fd6'),
    ('public.two_player_rpc(text,text,jsonb)','07bd70771529b5749c49810f8feb2f08')
  ) v(signature,hash) LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=entry.signature::regprocedure) IS DISTINCT FROM entry.hash THEN
      RAISE EXCEPTION 'Reviewed photo catalog boundary differs: %',entry.signature; END IF;
  END LOOP;
  IF NOT target_private.stickers_retired() OR (SELECT count(*) FROM target_private.sticker_catalog)<>17 OR
      EXISTS(SELECT 1 FROM target_private.active_gacha_receipts(NULL) WHERE item_type='sticker') THEN
    RAISE EXCEPTION 'Original sticker retirement must be complete before the photo catalog'; END IF;
  IF (SELECT logical_bytes+11*256>104857600 FROM target_private.system_state WHERE singleton) THEN
    RAISE EXCEPTION 'Photo catalog exceeds the private logical-storage quota' USING ERRCODE='54000'; END IF;
END $guard$;

ALTER TABLE target_private.sticker_catalog DROP CONSTRAINT sticker_catalog_ordinal_check;
ALTER TABLE target_private.sticker_catalog
  ADD COLUMN generation smallint NOT NULL DEFAULT 2,
  ADD CONSTRAINT sticker_catalog_generation CHECK(
    (generation=2 AND ordinal BETWEEN 1 AND 17) OR (generation=5 AND ordinal BETWEEN 18 AND 28));
INSERT INTO target_private.sticker_catalog(id,ordinal,generation) VALUES
  ('photo-boss',18,5),('photo-high-ground',19,5),('photo-wait',20,5),
  ('photo-limit',21,5),('photo-best',22,5),('photo-secret',23,5),
  ('photo-hmm',24,5),('photo-ready',25,5),('photo-proud',26,5),
  ('photo-hold-on',27,5),('photo-hello',28,5);
UPDATE target_private.system_state SET logical_bytes=logical_bytes+11*256 WHERE singleton;

CREATE OR REPLACE FUNCTION target_private.enforce_gacha_catalog_protocol()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='sticker_draws' THEN
    RAISE EXCEPTION 'Legacy sticker purchases are permanently retired' USING ERRCODE='42501'; END IF;
  IF current_setting('target.gacha_catalog_protocol',true) IS DISTINCT FROM '5' OR
      current_setting('target.gacha_price_protocol',true) IS DISTINCT FROM '100000' OR
      (NEW.item_type='sticker' AND NOT EXISTS(
        SELECT 1 FROM target_private.sticker_catalog WHERE id=NEW.sticker_id AND generation=5)) THEN
    RAISE EXCEPTION 'Current active photo-item gacha protocol required' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.sticker_draws d WHERE d.member_id=NEW.member_id AND d.request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'Historical request identifier is already used' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END $$;

DO $upgrade$
DECLARE definition text; marker text; replacement text; expected_count integer;
BEGIN
  SELECT pg_get_functiondef('target_private.wallet_snapshot(uuid)'::regprocedure) INTO definition;
  FOR marker,replacement,expected_count IN SELECT * FROM (VALUES
    ('''catalogVersion'',CASE WHEN target_private.stickers_retired() THEN 4 ELSE 3 END,''catalogSize'',CASE WHEN target_private.stickers_retired() THEN 0 ELSE 17 END',
      '''catalogVersion'',5,''catalogSize'',11',1),
    ('q.item_type=''sticker'' AND q.item_id=c.id','q.item_type=''sticker'' AND q.item_id=c.id AND c.generation=5',2),
    ('||CASE WHEN target_private.stickers_retired() THEN jsonb_build_object(''stickersRetired'',true) ELSE ''{}''::jsonb END','',1)
  ) changes(old_value,new_value,count_value) LOOP
    IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>expected_count THEN
      RAISE EXCEPTION 'Reviewed photo wallet marker changed: %',marker; END IF;
    definition:=replace(definition,marker,replacement);
  END LOOP;
  EXECUTE definition;
  SELECT pg_get_functiondef('public.target_shop_rpc(text,text,jsonb)'::regprocedure) INTO definition;
  FOR marker,replacement,expected_count IN SELECT * FROM (VALUES
    ('''1''::jsonb,''2''::jsonb,''3''::jsonb,''4''::jsonb','''1''::jsonb,''2''::jsonb,''3''::jsonb,''4''::jsonb,''5''::jsonb',1),
    ('IF p_action=''draw'' AND pool_kind=''sticker'' AND target_private.stickers_retired() AND NOT EXISTS('||chr(10)||
      '    SELECT 1 FROM target_private.gacha_receipts(member_uuid) WHERE request_id=(p_input->>''requestId'')::uuid) THEN'||chr(10)||
      '    RETURN target_private.error_result(410,''STICKERS_RETIRED'',''スタンプは現在利用できません。''); END IF;',
      'IF p_action=''draw'' AND NOT EXISTS('||chr(10)||
      '    SELECT 1 FROM target_private.gacha_receipts(member_uuid) WHERE request_id=(p_input->>''requestId'')::uuid) AND'||chr(10)||
      '    (coalesce((p_input->>''expectedCatalogVersion'')::integer,1)<>5 OR NOT(p_input?''itemType'')) THEN'||chr(10)||
      '    RETURN target_private.error_result(409,''CATALOG_CHANGED'',''ガチャの内容が変わりました。確認してからもう一度操作してください。''); END IF;',1),
    ('coalesce((p_input->>''expectedCatalogVersion'')::integer,1)<>(CASE WHEN target_private.stickers_retired() THEN 4 ELSE 3 END)',
      'coalesce((p_input->>''expectedCatalogVersion'')::integer,1)<>5',1),
    ('SELECT id INTO chosen_id FROM target_private.sticker_catalog ORDER BY ordinal OFFSET target_private.secure_random_int(17) LIMIT 1;',
      'SELECT id INTO chosen_id FROM target_private.sticker_catalog WHERE generation=5 ORDER BY ordinal OFFSET target_private.secure_random_int(11) LIMIT 1;',1),
    ('PERFORM set_config(''target.gacha_catalog_protocol'',CASE WHEN target_private.stickers_retired() THEN ''4'' ELSE ''3'' END,true);',
      'PERFORM set_config(''target.gacha_catalog_protocol'',''5'',true);',1)
  ) changes(old_value,new_value,count_value) LOOP
    IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>expected_count THEN
      RAISE EXCEPTION 'Reviewed photo shop marker changed: %',marker; END IF;
    definition:=replace(definition,marker,replacement);
  END LOOP;
  EXECUTE definition;
END $upgrade$;
REVOKE ALL ON FUNCTION target_private.enforce_gacha_catalog_protocol(),target_private.wallet_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON TABLE target_private.sticker_catalog FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
