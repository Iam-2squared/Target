-- Fifteen additional circular avatar frames from the approved 2026-11-11 contact sheet.
-- Additive catalog extension: no previous draws/ownership/finance records change.
-- Original rarity odds remain common=62, rare=25, epic=10, legendary=3.
DO $catalog$
DECLARE
  before_count integer;
  wallet_definition text;
  old_quota bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  SELECT COUNT(*) INTO before_count FROM target_private.frame_catalog;
  IF before_count<>33 OR (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='common')<>15 OR
     (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='rare')<>10 OR
     (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='epic')<>5 OR
     (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='legendary')<>3 THEN
    RAISE EXCEPTION 'Unexpected pre-expansion avatar frame catalog';
  END IF;
  IF EXISTS(SELECT 1 FROM target_private.frame_catalog WHERE ordinal NOT BETWEEN 1 AND 33) THEN
    RAISE EXCEPTION 'Unexpected avatar ordinal';
  END IF;
  SELECT logical_bytes INTO old_quota FROM target_private.system_state WHERE singleton FOR UPDATE;
  IF old_quota IS NULL OR old_quota>104857600-15*256 THEN
    RAISE EXCEPTION 'Insufficient app logical storage to add fifteen frames';
  END IF;

  -- Preserve the original IDs and ordinals. Only newly accepted IDs and sizes
  -- are widened, with the same rarity restrictions as before.
  ALTER TABLE target_private.frame_catalog DROP CONSTRAINT frame_catalog_check;
  ALTER TABLE target_private.frame_catalog ADD CONSTRAINT frame_catalog_check
    CHECK ((rarity='common' AND id ~ '^c(0[1-9]|1[0-5])$')
        OR (rarity='rare' AND id ~ '^r(0[1-9]|1[0-5])$')
        OR (rarity='epic' AND id ~ '^e(0[1-9]|10)$')
        OR (rarity='legendary' AND id ~ '^l0[1-8]$'));
  ALTER TABLE target_private.frame_catalog DROP CONSTRAINT frame_catalog_ordinal_check;
  ALTER TABLE target_private.frame_catalog ADD CONSTRAINT frame_catalog_ordinal_check
    CHECK(ordinal BETWEEN 1 AND 48);

  INSERT INTO target_private.frame_catalog(id,rarity,ordinal) VALUES
    ('r11','rare',34),('r12','rare',35),('r13','rare',36),('r14','rare',37),('r15','rare',38),
    ('e06','epic',39),('e07','epic',40),('e08','epic',41),('e09','epic',42),('e10','epic',43),
    ('l04','legendary',44),('l05','legendary',45),('l06','legendary',46),('l07','legendary',47),('l08','legendary',48);
  UPDATE target_private.system_state SET logical_bytes=logical_bytes+15*256 WHERE singleton;

  -- Rebuild the *existing* established v5 projection without modifying
  -- ownership, sales, refunds, receipt replay or ledger calculations.
  SELECT pg_get_functiondef('target_private.wallet_snapshot(uuid)'::regprocedure)
    INTO wallet_definition;
  IF wallet_definition IS NULL OR
     length(wallet_definition)-length(replace(wallet_definition,'''frameCatalogSize'',33',''))<>length('''frameCatalogSize'',33') THEN
    RAISE EXCEPTION 'Unexpected current wallet projection; refusing blind replacement';
  END IF;
  wallet_definition:=replace(wallet_definition,'''frameCatalogSize'',33','''frameCatalogSize'',48');
  EXECUTE wallet_definition;

  IF (SELECT COUNT(*) FROM target_private.frame_catalog)<>48 OR
     (SELECT COUNT(*) FROM target_private.frame_catalog WHERE rarity='common')<>15 OR
     (SELECT COUNT(*) FROM target_private.frame_catalog WHERE rarity='rare')<>15 OR
     (SELECT COUNT(*) FROM target_private.frame_catalog WHERE rarity='epic')<>10 OR
     (SELECT COUNT(*) FROM target_private.frame_catalog WHERE rarity='legendary')<>8 THEN
     RAISE EXCEPTION 'Invalid expanded frame catalog';
  END IF;
END $catalog$;

-- Keep existing private schema/RLS/immutable draws. New server calls
-- acknowledge the same catalogVersion 5; no expense or old receipt changes.
NOTIFY pgrst,'reload schema';
