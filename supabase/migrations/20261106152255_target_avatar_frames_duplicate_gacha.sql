-- Generated with supabase@3.0.0 migration new target_avatar_frames_duplicate_gacha.
-- Existing answers, income and legacy sticker receipts remain unchanged.
SELECT pg_advisory_xact_lock(991101);
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_shop_rpc(text,text,jsonb)'::regprocedure) IS DISTINCT FROM '71b67c265f1115c6315cc854952ee801' OR
     (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_snapshot(uuid)'::regprocedure) IS DISTINCT FROM '129323d881509b9608aba389b1b2e4ef' OR
     (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.enforce_gacha_catalog_protocol()'::regprocedure) IS DISTINCT FROM 'e68b83118c9c168583e15a5fe8cd7d42' THEN
    RAISE EXCEPTION 'Target wallet changed; review the item migration again';
  END IF;
  IF EXISTS(SELECT 1 FROM target_private.profiles p WHERE p.spent_points IS DISTINCT FROM coalesce((SELECT sum(d.cost) FROM target_private.sticker_draws d WHERE d.member_id=p.member_id),0)) THEN
    RAISE EXCEPTION 'Legacy spending and receipts disagree';
  END IF;
END $guard$;

CREATE TABLE target_private.frame_catalog (
  id text PRIMARY KEY CHECK(id ~ '^[crel][0-9]{2}$'),
  rarity text NOT NULL CHECK(rarity IN ('common','rare','epic','legendary')),
  ordinal smallint NOT NULL UNIQUE CHECK(ordinal BETWEEN 1 AND 33),
  CHECK((rarity='common' AND id ~ '^c(0[1-9]|1[0-5])$') OR
        (rarity='rare' AND id ~ '^r(0[1-9]|10)$') OR
        (rarity='epic' AND id ~ '^e0[1-5]$') OR
        (rarity='legendary' AND id ~ '^l0[1-3]$'))
);
INSERT INTO target_private.frame_catalog(id,rarity,ordinal)
 SELECT 'c'||lpad(n::text,2,'0'),'common',n FROM generate_series(1,15) n
 UNION ALL SELECT 'r'||lpad(n::text,2,'0'),'rare',15+n FROM generate_series(1,10) n
 UNION ALL SELECT 'e'||lpad(n::text,2,'0'),'epic',25+n FROM generate_series(1,5) n
 UNION ALL SELECT 'l'||lpad(n::text,2,'0'),'legendary',30+n FROM generate_series(1,3) n;
CREATE TABLE target_private.item_draws (
  member_id uuid NOT NULL REFERENCES target_private.profiles(member_id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  item_type text NOT NULL CHECK(item_type IN ('sticker','frame')),
  sticker_id text REFERENCES target_private.sticker_catalog(id),
  frame_id text REFERENCES target_private.frame_catalog(id),
  cost integer NOT NULL CHECK(cost=100000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(member_id,request_id),
  CHECK((item_type='sticker' AND sticker_id IS NOT NULL AND frame_id IS NULL) OR
        (item_type='frame' AND frame_id IS NOT NULL AND sticker_id IS NULL))
);
CREATE INDEX target_item_draws_sticker_idx ON target_private.item_draws(sticker_id) WHERE sticker_id IS NOT NULL;
CREATE INDEX target_item_draws_frame_idx ON target_private.item_draws(frame_id) WHERE frame_id IS NOT NULL;
ALTER TABLE target_private.frame_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.item_draws ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE target_private.frame_catalog,target_private.item_draws FROM PUBLIC,anon,authenticated;

-- Unbiased CSPRNG integers: UUIDv4's first four bytes contain32 random bits,
-- before its version/variant fields. Rejection sampling avoids modulo bias.
CREATE FUNCTION target_private.secure_random_int(p_bound integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE source bytea; sample bigint; threshold bigint;
BEGIN
  IF p_bound IS NULL OR p_bound<1 OR p_bound>10000 THEN RAISE EXCEPTION 'Invalid random bound' USING ERRCODE='22023'; END IF;
  threshold:=(4294967296::bigint/p_bound)*p_bound;
  LOOP
    source:=uuid_send(gen_random_uuid());
    sample:=get_byte(source,0)::bigint*16777216+get_byte(source,1)::bigint*65536+get_byte(source,2)::bigint*256+get_byte(source,3);
    IF sample<threshold THEN RETURN (sample%p_bound)::integer; END IF;
  END LOOP;
END $$;
CREATE FUNCTION target_private.frame_rarity_for_roll(p_roll integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF p_roll IS NULL OR p_roll<0 OR p_roll>=10000 THEN RAISE EXCEPTION 'Invalid rarity roll' USING ERRCODE='22023'; END IF;
  RETURN CASE WHEN p_roll<300 THEN 'legendary' WHEN p_roll<1300 THEN 'epic' WHEN p_roll<3800 THEN 'rare' ELSE 'common' END;
END $$;

-- The old table becomes a read-only historical ledger. An old compiled RPC
-- waiting on991101 cannot resume and silently buy under the former rules.
CREATE OR REPLACE FUNCTION target_private.enforce_gacha_catalog_protocol()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='sticker_draws' OR current_setting('target.gacha_catalog_protocol',true) IS DISTINCT FROM '3' OR
      current_setting('target.gacha_price_protocol',true) IS DISTINCT FROM '100000' THEN
    RAISE EXCEPTION 'Current duplicate-item gacha protocol required' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM target_private.sticker_draws d WHERE d.member_id=NEW.member_id AND d.request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'Historical request identifier is already used' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER target_item_catalog_protocol BEFORE INSERT ON target_private.item_draws FOR EACH ROW EXECUTE FUNCTION target_private.enforce_gacha_catalog_protocol();
CREATE FUNCTION target_private.immutable_item_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Purchase receipts are immutable' USING ERRCODE='42501';
END $$;
CREATE TRIGGER target_item_receipt_immutable BEFORE UPDATE OR DELETE ON target_private.item_draws FOR EACH ROW EXECUTE FUNCTION target_private.immutable_item_receipt();
CREATE TRIGGER target_legacy_receipt_immutable BEFORE UPDATE OR DELETE ON target_private.sticker_draws FOR EACH ROW EXECUTE FUNCTION target_private.immutable_item_receipt();

DO $quota$
BEGIN
  IF (SELECT logical_bytes+33*256>104857600 FROM target_private.system_state WHERE singleton FOR UPDATE) THEN RAISE EXCEPTION 'Frame catalog exceeds storage ceiling'; END IF;
  UPDATE target_private.system_state SET logical_bytes=logical_bytes+33*256 WHERE singleton;
END $quota$;

CREATE OR REPLACE FUNCTION target_private.wallet_snapshot(p_member uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  WITH receipts AS (
    SELECT 'sticker'::text AS item_type,sticker_id AS item_id,cost FROM target_private.sticker_draws WHERE member_id=p_member
    UNION ALL SELECT item_type,coalesce(sticker_id,frame_id),cost FROM target_private.item_draws WHERE member_id=p_member
  ), quantities AS (SELECT item_type,item_id,count(*)::integer AS quantity FROM receipts GROUP BY item_type,item_id)
  SELECT jsonb_build_object('balance',p.total_points-p.spent_points,'totalIncome',p.total_points,'spent',p.spent_points,
    'price',100000,'catalogVersion',3,'catalogSize',17,'frameCatalogSize',33,'duplicatesAllowed',true,
    'drawCount',(SELECT count(*)::integer FROM receipts),
    'legacyDiscountedDraws',(SELECT count(*)::integer FROM receipts WHERE cost=10000),
    'frameOdds',jsonb_build_object('common',62,'rare',25,'epic',10,'legendary',3),
    'ownedStickers',coalesce((SELECT jsonb_agg(c.id ORDER BY c.ordinal) FROM target_private.sticker_catalog c JOIN quantities q ON q.item_type='sticker' AND q.item_id=c.id),'[]'::jsonb),
    'stickerQuantities',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'quantity',q.quantity) ORDER BY c.ordinal) FROM target_private.sticker_catalog c JOIN quantities q ON q.item_type='sticker' AND q.item_id=c.id),'[]'::jsonb),
    'ownedFrames',coalesce((SELECT jsonb_agg(c.id ORDER BY c.ordinal) FROM target_private.frame_catalog c JOIN quantities q ON q.item_type='frame' AND q.item_id=c.id),'[]'::jsonb),
    'frameQuantities',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'quantity',q.quantity) ORDER BY c.ordinal) FROM target_private.frame_catalog c JOIN quantities q ON q.item_type='frame' AND q.item_id=c.id),'[]'::jsonb))
  FROM target_private.profiles p WHERE p.member_id=p_member;
$$;

CREATE OR REPLACE FUNCTION public.target_shop_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  member_uuid uuid; request_uuid uuid; display_name text; pool_kind text;
  saved_legacy target_private.sticker_draws%ROWTYPE; saved target_private.item_draws%ROWTYPE;
  profile target_private.profiles%ROWTYPE; chosen_id text; chosen_rarity text;
  chosen_count integer; wait_seconds integer; new_bytes integer; quantity integer;
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
      (p_input?'expectedCatalogVersion' AND p_input->'expectedCatalogVersion' NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb)) OR
      (p_input?'itemType' AND p_input->'itemType' NOT IN ('"sticker"'::jsonb,'"frame"'::jsonb)))) THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
  END IF;
  member_uuid:=(p_input->>'memberId')::uuid; display_name:=btrim(p_input->>'name'); pool_kind:=coalesce(p_input->>'itemType','sticker');
  PERFORM pg_advisory_xact_lock(991101);
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
    SELECT count(*)::integer INTO quantity FROM (SELECT sticker_id FROM target_private.sticker_draws WHERE member_id=member_uuid UNION ALL SELECT sticker_id FROM target_private.item_draws WHERE member_id=member_uuid AND item_type='sticker') d WHERE d.sticker_id=saved_legacy.sticker_id;
    RETURN target_private.wallet_snapshot(member_uuid)||jsonb_build_object('requestId',request_uuid,'itemType','sticker','itemId',saved_legacy.sticker_id,'stickerId',saved_legacy.sticker_id,'cost',saved_legacy.cost,'quantity',quantity);
  END IF;
  SELECT * INTO saved FROM target_private.item_draws WHERE member_id=member_uuid AND request_id=request_uuid;
  IF FOUND THEN
    IF pool_kind<>saved.item_type THEN RETURN target_private.error_result(409,'REQUEST_ID_CONFLICT','同じ操作IDの内容が異なります。'); END IF;
    chosen_id:=coalesce(saved.sticker_id,saved.frame_id); chosen_rarity:=(SELECT rarity FROM target_private.frame_catalog WHERE id=saved.frame_id);
  ELSE
    IF coalesce((p_input->>'expectedPrice')::integer,10000)<>100000 THEN RETURN target_private.error_result(409,'PRICE_CHANGED','価格を確認してからもう一度操作してください。'); END IF;
    IF coalesce((p_input->>'expectedCatalogVersion')::integer,1)<>3 OR NOT(p_input?'itemType') THEN RETURN target_private.error_result(409,'CATALOG_CHANGED','ガチャの内容が変わりました。確認してからもう一度操作してください。'); END IF;
    wait_seconds:=target_private.consume_rate('shop-draw:'||member_uuid::text,60,10);
    IF wait_seconds>0 THEN RETURN jsonb_set(target_private.error_result(429,'RATE_LIMITED','しばらく待ってからお試しください。'),'{error,retryAfter}',to_jsonb(wait_seconds)); END IF;
    IF profile.total_points-profile.spent_points<100000 THEN RETURN target_private.error_result(409,'INSUFFICIENT_BALANCE','保有金額が100,000轟に足りません。'); END IF;
    IF pool_kind='sticker' THEN
      SELECT id INTO chosen_id FROM target_private.sticker_catalog ORDER BY ordinal OFFSET target_private.secure_random_int(17) LIMIT 1;
    ELSE
      chosen_rarity:=target_private.frame_rarity_for_roll(target_private.secure_random_int(10000));
      SELECT count(*)::integer INTO chosen_count FROM target_private.frame_catalog WHERE rarity=chosen_rarity;
      SELECT id INTO chosen_id FROM target_private.frame_catalog WHERE rarity=chosen_rarity ORDER BY ordinal OFFSET target_private.secure_random_int(chosen_count) LIMIT 1;
    END IF;
    new_bytes:=pg_column_size(jsonb_build_object('memberId',member_uuid,'requestId',request_uuid,'itemType',pool_kind,'itemId',chosen_id,'cost',100000))+320;
    IF (SELECT logical_bytes+new_bytes>104857600 FROM target_private.system_state WHERE singleton FOR UPDATE) THEN RETURN target_private.error_result(507,'CAPACITY_LIMIT','保存容量の上限に達しました。'); END IF;
    PERFORM set_config('target.gacha_price_protocol','100000',true); PERFORM set_config('target.gacha_catalog_protocol','3',true);
    INSERT INTO target_private.item_draws(member_id,request_id,item_type,sticker_id,frame_id,cost) VALUES(member_uuid,request_uuid,pool_kind,CASE WHEN pool_kind='sticker' THEN chosen_id END,CASE WHEN pool_kind='frame' THEN chosen_id END,100000) RETURNING * INTO saved;
    UPDATE target_private.profiles SET spent_points=spent_points+100000 WHERE member_id=member_uuid;
    UPDATE target_private.system_state SET logical_bytes=logical_bytes+new_bytes WHERE singleton;
  END IF;
  IF saved.item_type='sticker' THEN
    SELECT count(*)::integer INTO quantity FROM (SELECT sticker_id FROM target_private.sticker_draws WHERE member_id=member_uuid UNION ALL SELECT sticker_id FROM target_private.item_draws WHERE member_id=member_uuid AND item_type='sticker') d WHERE d.sticker_id=chosen_id;
  ELSE SELECT count(*)::integer INTO quantity FROM target_private.item_draws WHERE member_id=member_uuid AND frame_id=chosen_id; END IF;
  RETURN target_private.wallet_snapshot(member_uuid)||jsonb_build_object('requestId',request_uuid,'itemType',saved.item_type,'itemId',chosen_id,'cost',saved.cost,'quantity',quantity)||
    CASE WHEN saved.item_type='sticker' THEN jsonb_build_object('stickerId',chosen_id) ELSE jsonb_build_object('frameId',chosen_id,'rarity',chosen_rarity) END;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR check_violation OR not_null_violation THEN
  RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
END $$;

REVOKE ALL ON FUNCTION target_private.secure_random_int(integer),target_private.frame_rarity_for_roll(integer),target_private.immutable_item_receipt(),target_private.enforce_gacha_catalog_protocol(),target_private.wallet_snapshot(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.target_shop_rpc(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.target_shop_rpc(text,text,jsonb) TO anon;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON TABLE target_private.frame_catalog,target_private.item_draws FROM service_role;
    REVOKE ALL ON FUNCTION target_private.secure_random_int(integer),target_private.frame_rarity_for_roll(integer),target_private.immutable_item_receipt() FROM service_role;
  END IF;
END $$;
COMMENT ON FUNCTION public.target_shop_rpc(text,text,jsonb) IS 'Server-credential wallet and immutable duplicate-item purchases; two acknowledged pools and private weighted frame draws.';
