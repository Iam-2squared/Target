-- Generated with Supabase CLI 3.1.0 migration new target_two_player_unlimited_stakes.
-- Remove the game-specific stake cap. Existing wallet representability,
-- available balance, payout headroom and 100-轟 increments remain authoritative.
BEGIN;
SET LOCAL lock_timeout = '15s';
SELECT pg_advisory_xact_lock(991101);
SELECT 1 FROM target_private.system_state WHERE singleton FOR UPDATE;

DO $guard$
DECLARE expected record; relation text; digest text; snapshot jsonb:='{}'::jsonb;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.two_player_rpc(text,text,jsonb)','625162362bf7d46fa98b19f254ee5671'),
    ('public.two_player_lobby_rpc(text,text,jsonb)','43af0ba7428282aa4e9b29ace3424a83'),
    ('target_private.two_player_money(uuid,uuid,text,text,integer)','536c0e60d75fca1a97058633b9f73138'),
    ('target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer)','5161a2f3b98b94e07d0927a28093893f'),
    ('target_private.two_player_wallet_headroom()','b33b252d99dec8143a2556ea134607b3'),
    ('target_private.wallet_finance_projection(timestamptz)','8e69577732c1f54b2dae637b87aa3fd6'),
    ('public.target_games_rpc(text,text,jsonb)','71ddbc56e79a79dcd8a046d556b73a59')
  ) x(signature,hash) LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure) IS DISTINCT FROM expected.hash THEN
      RAISE EXCEPTION 'Reviewed stake or financial boundary changed: %',expected.signature; END IF;
  END LOOP;
  -- Source/ownership/wallet values and all existing match and receipt values
  -- must survive this schema-only change, including currently funded matches.
  FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='target_private' AND c.relkind='r' AND c.relname NOT LIKE '%credentials'
      AND c.relname NOT LIKE '%rates' AND c.relname<>'two_player_lobby_presence' ORDER BY c.relname LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text),%L ORDER BY md5(to_jsonb(t)::text)),%L)) FROM target_private.%I t',
      '','',relation) INTO digest;
    snapshot:=snapshot||jsonb_build_object(relation,digest);
  END LOOP;
  PERFORM set_config('target.stake_schema_before',snapshot::text,true);
END $guard$;

ALTER TABLE target_private.two_player_matches
  DROP CONSTRAINT two_player_matches_host_offer_check,
  DROP CONSTRAINT two_player_matches_guest_offer_check,
  DROP CONSTRAINT two_player_matches_stake_check,
  DROP CONSTRAINT two_player_matches_escrow_check,
  ALTER COLUMN host_offer TYPE bigint,
  ALTER COLUMN guest_offer TYPE bigint,
  ALTER COLUMN stake TYPE bigint,
  ALTER COLUMN escrow TYPE bigint,
  ADD CONSTRAINT two_player_matches_host_offer_check CHECK(host_offer BETWEEN 100 AND 10000000000000 AND host_offer%100=0),
  ADD CONSTRAINT two_player_matches_guest_offer_check CHECK(guest_offer BETWEEN 100 AND 10000000000000 AND guest_offer%100=0),
  ADD CONSTRAINT two_player_matches_stake_check CHECK(stake BETWEEN 100 AND 10000000000000 AND stake%100=0),
  ADD CONSTRAINT two_player_matches_escrow_check CHECK(escrow BETWEEN 0 AND 20000000000000 AND escrow%200=0);
ALTER TABLE target_private.two_player_wallet_events
  DROP CONSTRAINT two_player_wallet_events_delta_check,
  ALTER COLUMN delta TYPE bigint,
  ADD CONSTRAINT two_player_wallet_events_delta_check CHECK(delta BETWEEN -10000000000000 AND 20000000000000 AND delta%100=0);
ALTER TABLE target_private.two_player_lobby_queue
  DROP CONSTRAINT two_player_lobby_queue_stake_check,
  ALTER COLUMN stake TYPE bigint,
  ADD CONSTRAINT two_player_lobby_queue_stake_check CHECK(stake BETWEEN 100 AND 10000000000000 AND stake%100=0);
ALTER TABLE target_private.two_player_lobby_invites
  DROP CONSTRAINT two_player_lobby_invites_stake_check,
  ALTER COLUMN stake TYPE bigint,
  ADD CONSTRAINT two_player_lobby_invites_stake_check CHECK(stake BETWEEN 100 AND 10000000000000 AND stake%100=0);

-- Keep the financial helper's reviewed implementation; only its argument type
-- changes. Retain inaccessible integer forwarding signatures for old in-flight
-- PL/pgSQL plans compiled before the shared ledger lock was acquired.
DO $helpers$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('target_private.two_player_money(uuid,uuid,text,text,integer)'::regprocedure) INTO definition;
  IF position('p_delta integer' IN definition)=0 THEN RAISE EXCEPTION 'Money argument marker changed'; END IF;
  EXECUTE replace(definition,'p_delta integer','p_delta bigint');
  SELECT pg_get_functiondef('target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer)'::regprocedure) INTO definition;
  IF position('p_a_stake integer' IN definition)=0 OR position('p_b_stake integer' IN definition)=0 OR
    position('host_stake integer:=p_a_stake; guest_stake integer:=p_b_stake;' IN definition)=0 THEN
    RAISE EXCEPTION 'Lobby amount markers changed'; END IF;
  definition:=replace(replace(replace(definition,'p_a_stake integer','p_a_stake bigint'),
    'p_b_stake integer','p_b_stake bigint'),
    'host_stake integer:=p_a_stake; guest_stake integer:=p_b_stake;',
    'host_stake bigint:=p_a_stake; guest_stake bigint:=p_b_stake;');
  EXECUTE definition;
  SELECT pg_get_functiondef('target_private.two_player_wallet_headroom()'::regprocedure) INTO definition;
  IF position('DECLARE pending integer;' IN definition)=0 THEN RAISE EXCEPTION 'Headroom marker changed'; END IF;
  EXECUTE replace(definition,'DECLARE pending integer;','DECLARE pending bigint;');
END $helpers$;
CREATE OR REPLACE FUNCTION target_private.two_player_money(p_id uuid,p_member uuid,p_phase text,p_kind text,p_delta integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM target_private.two_player_money(p_id,p_member,p_phase,p_kind,p_delta::bigint);
END $$;
CREATE OR REPLACE FUNCTION target_private.two_player_lobby_pair(p_secret text,p_a uuid,p_b uuid,
  p_a_stake integer,p_a_formation integer,p_b_stake integer,p_b_formation integer)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RETURN target_private.two_player_lobby_pair(p_secret,p_a,p_b,p_a_stake::bigint,p_a_formation,p_b_stake::bigint,p_b_formation);
END $$;
REVOKE ALL ON FUNCTION target_private.two_player_money(uuid,uuid,text,text,bigint),
  target_private.two_player_money(uuid,uuid,text,text,integer),
  target_private.two_player_lobby_pair(text,uuid,uuid,bigint,integer,bigint,integer),
  target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer),
  target_private.two_player_wallet_headroom() FROM PUBLIC,anon,authenticated,service_role;

-- Precise transformations retain every authentication, consent, idempotency,
-- global lock, payout-headroom, formation, turn-clock and settlement branch.
DO $rpc$
DECLARE signature text; definition text; marker text; replacement text; expected_count integer;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.two_player_rpc(text,text,jsonb)','public.two_player_lobby_rpc(text,text,jsonb)'] LOOP
    SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
    FOR marker,replacement,expected_count IN SELECT * FROM (VALUES
      ('stake_value integer;','stake_value bigint;',1),
      ('''^[0-9]{3,6}$''','''^[1-9][0-9]{2,13}$''',1),
      ('stake_value:=(p_input->>''stake'')::integer','stake_value:=(p_input->>''stake'')::bigint',
        CASE WHEN signature='public.two_player_rpc(text,text,jsonb)' THEN 2 ELSE 1 END),
      ('stake_value NOT BETWEEN 100 AND 100000 OR','stake_value NOT BETWEEN 100 AND 10000000000000 OR',1),
      (CASE WHEN signature='public.two_player_rpc(text,text,jsonb)' THEN '賭け金は100〜100,000轟の100轟単位です。' ELSE '賭け額は100〜100,000轟の100轟単位です。' END,
        '賭け額は100轟以上、100轟単位で指定してください。',
        CASE WHEN signature='public.two_player_rpc(text,text,jsonb)' THEN 2 ELSE 1 END)
    ) changes(old_value,new_value,count_value) LOOP
      IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>expected_count THEN
        RAISE EXCEPTION 'Reviewed stake marker changed: % %',signature,marker; END IF;
      definition:=replace(definition,marker,replacement);
    END LOOP;
    EXECUTE definition;
  END LOOP;
END $rpc$;

DO $preserved$
DECLARE before_state jsonb:=current_setting('target.stake_schema_before')::jsonb;
  after_state jsonb:='{}'::jsonb; relation text; digest text;
BEGIN
  FOR relation IN SELECT jsonb_object_keys(before_state) LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text),%L ORDER BY md5(to_jsonb(t)::text)),%L)) FROM target_private.%I t',
      '','',relation) INTO digest;
    after_state:=after_state||jsonb_build_object(relation,digest);
  END LOOP;
  IF after_state IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'Stake schema change modified existing data'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches m LEFT JOIN LATERAL(
    SELECT coalesce(sum(e.delta),0) AS delta FROM target_private.two_player_wallet_events e WHERE e.match_id=m.id) ledger ON true
    WHERE ledger.delta+m.escrow<>0) THEN RAISE EXCEPTION 'Soccer ledger and escrow do not conserve funds'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet history no longer reconciles'; END IF;
END $preserved$;
COMMENT ON FUNCTION public.two_player_rpc(text,text,jsonb) IS
  'Alternating soccer V2 with wallet-sized bigint stakes, explicit shared-wallet escrow consent and unchanged deterministic turn rules.';
COMMENT ON FUNCTION public.two_player_lobby_rpc(text,text,jsonb) IS
  'Private-credential lobby with wallet-sized bigint offers, online invitations and FIFO matching; settlement requires both confirmations.';
COMMIT;
