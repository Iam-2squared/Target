-- Synthetic verification only; all writes are rolled back. Does not read or
-- replace server credentials, real profiles, conversations or quiz answers.
BEGIN;
SELECT pg_advisory_xact_lock(991101);
DO $verify$
DECLARE
  test_member uuid:=gen_random_uuid();
  test_request uuid:=gen_random_uuid();
  value jsonb;
BEGIN
  IF (SELECT count(*) FROM target_private.frame_catalog)<>33 OR
     (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='common')<>15 OR
     (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='rare')<>10 OR
     (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='epic')<>5 OR
     (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='legendary')<>3 THEN
    RAISE EXCEPTION 'Unexpected frame catalog';
  END IF;
  IF (SELECT count(*) FROM generate_series(0,9999) i WHERE target_private.frame_rarity_for_roll(i)='legendary')<>300 OR
     (SELECT count(*) FROM generate_series(0,9999) i WHERE target_private.frame_rarity_for_roll(i)='epic')<>1000 OR
     (SELECT count(*) FROM generate_series(0,9999) i WHERE target_private.frame_rarity_for_roll(i)='rare')<>2500 OR
     (SELECT count(*) FROM generate_series(0,9999) i WHERE target_private.frame_rarity_for_roll(i)='common')<>6200 THEN
    RAISE EXCEPTION 'Unexpected exact frame probabilities';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('target_private.frame_catalog'::regclass,'target_private.item_draws'::regclass) AND NOT relrowsecurity) OR
     has_table_privilege('anon','target_private.item_draws','SELECT') OR
     has_table_privilege('authenticated','target_private.item_draws','INSERT') OR
     has_table_privilege('anon','target_private.frame_catalog','SELECT') OR
     has_function_privilege('anon','target_private.secure_random_int(integer)','EXECUTE') OR
     has_function_privilege('authenticated','target_private.wallet_snapshot(uuid)','EXECUTE') OR
     has_schema_privilege('anon','target_private','USAGE') THEN
    RAISE EXCEPTION 'Unexpected browser permissions';
  END IF;
  INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count)
    VALUES(test_member,'検証専用',1000000,100,100);
  PERFORM set_config('target.gacha_price_protocol','100000',true);
  PERFORM set_config('target.gacha_catalog_protocol','3',true);
  INSERT INTO target_private.item_draws(member_id,request_id,item_type,frame_id,cost)
    VALUES(test_member,test_request,'frame','l03',100000),
          (test_member,gen_random_uuid(),'frame','l03',100000);
  INSERT INTO target_private.item_draws(member_id,request_id,item_type,sticker_id,cost)
    VALUES(test_member,gen_random_uuid(),'sticker','youth',100000),
          (test_member,gen_random_uuid(),'sticker','youth',100000);
  UPDATE target_private.profiles SET spent_points=400000 WHERE member_id=test_member;
  value:=target_private.wallet_snapshot(test_member);
  IF value->'drawCount'<>'4'::jsonb OR value->'spent'<>'400000'::jsonb OR value->'balance'<>'600000'::jsonb OR
     value->'catalogVersion'<>'3'::jsonb OR value->'duplicatesAllowed'<>'true'::jsonb OR
     value->'stickerQuantities'<>'[{"id":"youth","quantity":2}]'::jsonb OR
     value->'frameQuantities'<>'[{"id":"l03","quantity":2}]'::jsonb THEN
    RAISE EXCEPTION 'Duplicate wallet snapshot is incoherent';
  END IF;
  BEGIN
    INSERT INTO target_private.item_draws(member_id,request_id,item_type,sticker_id,cost)
      VALUES(test_member,test_request,'sticker','youth',100000);
    RAISE EXCEPTION 'A request ID crossed pools';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE target_private.item_draws SET frame_id='l02' WHERE member_id=test_member AND request_id=test_request;
    RAISE EXCEPTION 'A receipt was mutable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO target_private.sticker_draws(member_id,request_id,sticker_id,cost)
      VALUES(test_member,gen_random_uuid(),'night',100000);
    RAISE EXCEPTION 'The legacy insert path remained enabled';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $verify$;
SELECT 'synthetic frame catalog, exact odds, duplicate receipts, immutable IDs and permissions passed' AS verification;
SELECT proname,md5(prosrc) AS body_hash FROM pg_proc WHERE oid IN (
 'public.target_shop_rpc(text,text,jsonb)'::regprocedure,
 'target_private.wallet_snapshot(uuid)'::regprocedure,
 'target_private.enforce_gacha_catalog_protocol()'::regprocedure,
 'target_private.secure_random_int(integer)'::regprocedure,
 'target_private.frame_rarity_for_roll(integer)'::regprocedure
) ORDER BY proname;
ROLLBACK;
