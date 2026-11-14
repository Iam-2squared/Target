BEGIN READ ONLY;
DO $verify$
DECLARE entry record; role_name text; wallet jsonb;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('public.target_shop_rpc(text,text,jsonb)','e4a994d46d5af83d715a1b5db200d434'),
    ('target_private.wallet_snapshot(uuid)','ef1f80ffb4e59cd6ec87a19bc65de117'),
    ('target_private.enforce_gacha_catalog_protocol()','5d0a755420fe4746475363fb4e4c4bd2'),
    ('target_private.stickers_retired()','db7f41f5b602350ad1fde9ba99c6a1da'),
    ('target_private.wallet_finance_projection(timestamptz)','8e69577732c1f54b2dae637b87aa3fd6'),
    ('public.two_player_rpc(text,text,jsonb)','07bd70771529b5749c49810f8feb2f08')
  ) v(signature,hash) LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=entry.signature::regprocedure) IS DISTINCT FROM entry.hash THEN
      RAISE EXCEPTION 'Photo catalog or unchanged financial boundary differs: %',entry.signature; END IF;
  END LOOP;
  IF NOT target_private.stickers_retired() OR (SELECT count(*) FROM target_private.sticker_catalog WHERE generation=2)<>17 OR
      (SELECT jsonb_agg(id ORDER BY ordinal) FROM target_private.sticker_catalog WHERE generation=5) IS DISTINCT FROM
      '["photo-boss","photo-high-ground","photo-wait","photo-limit","photo-best","photo-secret","photo-hmm","photo-ready","photo-proud","photo-hold-on","photo-hello"]'::jsonb OR
      (SELECT count(*) FROM target_private.sticker_catalog)<>28 OR
      EXISTS(SELECT 1 FROM target_private.active_gacha_receipts(NULL) r JOIN target_private.sticker_catalog c ON c.id=r.item_id
        WHERE r.item_type='sticker' AND c.generation<>5) THEN
    RAISE EXCEPTION 'Photo pool differs or refunded old stamps became active'; END IF;
  IF NOT(SELECT relrowsecurity FROM pg_class WHERE oid='target_private.sticker_catalog'::regclass) THEN
    RAISE EXCEPTION 'Private photo catalog is missing RLS'; END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_table_privilege(role_name,'target_private.sticker_catalog','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
        has_function_privilege(role_name,'target_private.wallet_snapshot(uuid)','EXECUTE') OR
        has_function_privilege(role_name,'target_private.enforce_gacha_catalog_protocol()','EXECUTE') THEN
      RAISE EXCEPTION 'API role can access a private catalog boundary'; END IF;
  END LOOP;
  FOR entry IN SELECT member_id FROM target_private.profiles LOOP
    wallet:=target_private.wallet_snapshot(entry.member_id);
    IF wallet->'catalogVersion'<>'5'::jsonb OR wallet->'catalogSize'<>'11'::jsonb OR wallet?'stickersRetired' OR
        wallet->'frameCatalogSize'<>'33'::jsonb OR wallet->'price'<>'100000'::jsonb OR wallet->'duplicatesAllowed'<>'true'::jsonb OR
        (wallet->>'drawCount')::bigint-coalesce((wallet->>'voidedDrawCount')::bigint,0)<>
          (SELECT count(*) FROM target_private.active_gacha_receipts(entry.member_id)) OR
        (wallet->>'spent')::bigint+coalesce((wallet->>'refundedSpend')::bigint,0)<>
          (wallet->>'drawCount')::bigint*100000-(wallet->>'legacyDiscountedDraws')::bigint*90000+coalesce((wallet->>'mapSpent')::bigint,0) THEN
      RAISE EXCEPTION 'Photo inventory and historical cost proof disagree'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Financial projection no longer reconciles'; END IF;
END $verify$;
SELECT 'target_photo_sticker_catalog_postflight_passed' AS result;
COMMIT;
