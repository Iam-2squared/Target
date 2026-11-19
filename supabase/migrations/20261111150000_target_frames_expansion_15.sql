-- Extend the existing circular avatar-frame rarity pools by 5 Rare, 5 Epic,
-- and 5 Legendary IDs. Do not alter wallet history, receipts, draws or odds.
-- All changes are in one transaction, under the existing global money lock.
DO $expand$
DECLARE original_count integer; definition text; new_definition text;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  SELECT count(*) INTO original_count FROM target_private.frame_catalog;
  IF original_count<>33 OR EXISTS(
    SELECT 1 FROM (
      VALUES('common',15),('rare',10),('epic',5),('legendary',3)
    ) AS expected(rarity,n)
    WHERE (SELECT count(*) FROM target_private.frame_catalog c WHERE c.rarity=expected.rarity)<>expected.n
  ) THEN
    RAISE EXCEPTION 'Unexpected frame catalog; expansion needs fresh review';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid='target_private.wallet_snapshot(uuid)'::regprocedure)
      <> '6840aff42232d406dcace58921cca005' THEN
    RAISE EXCEPTION 'Target wallet definition changed: review required';
  END IF;

  ALTER TABLE target_private.frame_catalog DROP CONSTRAINT frame_catalog_check;
  ALTER TABLE target_private.frame_catalog ADD CONSTRAINT frame_catalog_check CHECK(
    (rarity='common' AND id ~ '^c(0[1-9]|1[0-5])$') OR
    (rarity='rare' AND id ~ '^r(0[1-9]|1[0-5])$') OR
    (rarity='epic' AND id ~ '^e(0[1-9]|10)$') OR
    (rarity='legendary' AND id ~ '^l0[1-8]$')
  );
  ALTER TABLE target_private.frame_catalog DROP CONSTRAINT frame_catalog_ordinal_check;
  ALTER TABLE target_private.frame_catalog ADD CONSTRAINT frame_catalog_ordinal_check
    CHECK(ordinal BETWEEN 1 AND 48);

  -- At most 256 accounting bytes per new catalog entry, under existing 100 MiB cap.
  UPDATE target_private.system_state
    SET logical_bytes=logical_bytes+15*256
    WHERE singleton AND logical_bytes<=104857600-15*256;
  IF NOT FOUND THEN RAISE EXCEPTION 'Frame catalog accounting limit reached'; END IF;

  INSERT INTO target_private.frame_catalog(id,rarity,ordinal) VALUES
    ('r11','rare',34),('r12','rare',35),('r13','rare',36),
    ('r14','rare',37),('r15','rare',38),
    ('e06','epic',39),('e07','epic',40),('e08','epic',41),
    ('e09','epic',42),('e10','epic',43),
    ('l04','legendary',44),('l05','legendary',45),
    ('l06','legendary',46),('l07','legendary',47),('l08','legendary',48);

  SELECT pg_get_functiondef('target_private.wallet_snapshot(uuid)'::regprocedure)
    INTO definition;
  IF position('''frameCatalogSize'',33' IN definition)=0 OR
     (length(definition)-length(replace(definition,'''frameCatalogSize'',33','')))
      <> length('''frameCatalogSize'',33') THEN
    RAISE EXCEPTION 'Unexpected frameCatalogSize source';
  END IF;
  new_definition:=replace(definition,'''frameCatalogSize'',33','''frameCatalogSize'',48');
  EXECUTE new_definition;

  IF (SELECT count(*) FROM target_private.frame_catalog)<>48 THEN
    RAISE EXCEPTION 'Frame catalog size not 48';
  END IF;
END $expand$;
NOTIFY pgrst, 'reload schema';
