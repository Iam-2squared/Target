-- Generated with Supabase CLI 3.1.0 migration new target_two_player_unequal_stakes.
-- Each participant approves the displayed pair, pays their own offer and can
-- win the sum. Existing funded amounts, histories and source ledgers survive.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
SELECT 1 FROM target_private.system_state WHERE singleton FOR UPDATE;
DO $guard$
DECLARE expected record; relation text; digest text; snapshot jsonb:='{}'::jsonb;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.two_player_rpc(text,text,jsonb)','a31ef2f093dc1dc3204cd9683047c17d'),
    ('target_private.two_player_settle(uuid,text,text,text)','bcd0fae5b63e4ae7695f765551516843'),
    ('target_private.two_player_match_dto(uuid,boolean)','b746278bd91fbdc8a325a2372dc6d1b3'),
    ('target_private.two_player_wallet(uuid)','fa999f837498210b6acb96b818ce227a'),
    ('target_private.two_player_wallet_headroom()','02ea9fa563451bce080961a168c93fcb'),
    ('target_private.wallet_finance_projection(timestamptz)','8e69577732c1f54b2dae637b87aa3fd6'),
    ('public.target_games_rpc(text,text,jsonb)','71ddbc56e79a79dcd8a046d556b73a59')
  ) x(signature,hash) LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure) IS DISTINCT FROM expected.hash THEN
      RAISE EXCEPTION 'Reviewed unequal-stake boundary changed: %',expected.signature; END IF;
  END LOOP;
  FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='target_private' AND c.relkind='r' AND c.relname NOT IN ('rate_limits','two_player_lobby_presence')
      AND c.relname NOT LIKE '%credentials' AND c.relname NOT LIKE '%rates' ORDER BY c.relname LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(md5((to_jsonb(t)-%L)::text),%L ORDER BY md5((to_jsonb(t)-%L)::text)),%L)) FROM target_private.%I t',
      CASE WHEN relation='two_player_matches' THEN 'guest_stake' ELSE '__absent_stake_field__' END,'',
      CASE WHEN relation='two_player_matches' THEN 'guest_stake' ELSE '__absent_stake_field__' END,'',relation) INTO digest;
    snapshot:=snapshot||jsonb_build_object(relation,digest);
  END LOOP;
  PERFORM set_config('target.unequal_stakes_before',snapshot::text,true);
END $guard$;

ALTER TABLE target_private.two_player_matches
  ADD COLUMN guest_stake bigint CHECK(guest_stake BETWEEN 100 AND 10000000000000 AND guest_stake%100=0),
  ADD CONSTRAINT two_player_guest_stake_funded CHECK(stake IS NOT NULL OR guest_stake IS NULL),
  DROP CONSTRAINT two_player_matches_escrow_check,
  ADD CONSTRAINT two_player_matches_escrow_check CHECK(escrow BETWEEN 0 AND 20000000000000 AND escrow%100=0);
DO $constraint$
DECLARE entry record; matches integer:=0;
BEGIN
  FOR entry IN SELECT conname FROM pg_constraint WHERE conrelid='target_private.two_player_matches'::regclass
      AND contype='c' AND position('host_ready' IN pg_get_constraintdef(oid))>0 LOOP
    EXECUTE format('ALTER TABLE target_private.two_player_matches DROP CONSTRAINT %I',entry.conname); matches:=matches+1;
  END LOOP;
  IF matches<>1 THEN RAISE EXCEPTION 'Reviewed funding constraint changed'; END IF;
END $constraint$;
ALTER TABLE target_private.two_player_matches ADD CONSTRAINT two_player_matches_funding_check CHECK(
  (status='playing' AND stake IS NOT NULL AND escrow=stake+coalesce(guest_stake,stake)
    AND guest_id IS NOT NULL AND host_ready AND guest_ready) OR (status<>'playing' AND escrow=0));

-- Canonical event and transition checks also fence old compiled common-stake
-- writers. They cannot debit a guest at the host's amount or refund it later.
CREATE FUNCTION target_private.two_player_validate_money()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE m target_private.two_player_matches%rowtype; wanted bigint; own_amount bigint; pot bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  SELECT * INTO STRICT m FROM target_private.two_player_matches WHERE id=NEW.match_id FOR UPDATE;
  IF NEW.member_id<>m.host_id AND NEW.member_id IS DISTINCT FROM m.guest_id THEN
    RAISE EXCEPTION 'Soccer money belongs to a participant' USING ERRCODE='23514'; END IF;
  IF NEW.phase='reserve' THEN
    IF m.status<>'waiting' OR m.stake IS NOT NULL OR m.guest_id IS NULL OR NOT(m.host_ready AND m.guest_ready) OR
      (m.host_offer<>m.guest_offer AND current_setting('target.two_player_offer_consent',true) IS DISTINCT FROM
        m.id::text||':'||m.host_offer::text||':'||m.guest_offer::text) THEN
      RAISE EXCEPTION 'Soccer funding requires both current offer approvals' USING ERRCODE='23514'; END IF;
    wanted:=-CASE WHEN NEW.member_id=m.host_id THEN m.host_offer ELSE m.guest_offer END;
    IF NEW.kind<>'reserve' THEN RAISE EXCEPTION 'Invalid soccer reserve event' USING ERRCODE='23514'; END IF;
  ELSIF NEW.phase='settle' THEN
    own_amount:=CASE WHEN NEW.member_id=m.host_id THEN m.stake ELSE coalesce(m.guest_stake,m.stake) END;
    pot:=m.stake+coalesce(m.guest_stake,m.stake);
    IF m.stake IS NULL OR m.status NOT IN ('finished','cancelled') OR m.escrow<>0 THEN
      RAISE EXCEPTION 'Soccer payout requires a funded terminal match' USING ERRCODE='23514'; END IF;
    IF m.status='finished' AND m.winner IN ('host','guest') AND NEW.kind='payout' THEN
      wanted:=CASE WHEN (m.winner='host' AND NEW.member_id=m.host_id) OR
        (m.winner='guest' AND NEW.member_id=m.guest_id) THEN pot ELSE 0 END;
    ELSIF NEW.kind='refund' AND ((m.status='cancelled' AND m.winner IS NULL) OR
        (m.status='finished' AND m.winner='draw')) THEN wanted:=own_amount;
    ELSE RAISE EXCEPTION 'Soccer payout kind disagrees with result' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'Invalid soccer financial phase' USING ERRCODE='23514'; END IF;
  IF NEW.delta IS DISTINCT FROM wanted THEN
    RAISE EXCEPTION 'Soccer cashflow does not match the funded participant amount' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER two_player_money_canonical BEFORE INSERT ON target_private.two_player_wallet_events
  FOR EACH ROW EXECUTE FUNCTION target_private.two_player_validate_money();
CREATE FUNCTION target_private.two_player_guard_funded_stakes()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.stake IS NOT NULL AND
      (NEW.stake,NEW.guest_stake,NEW.host_offer,NEW.guest_offer,NEW.host_id,NEW.guest_id) IS DISTINCT FROM
      (OLD.stake,OLD.guest_stake,OLD.host_offer,OLD.guest_offer,OLD.host_id,OLD.guest_id) THEN
      RAISE EXCEPTION 'Funded soccer amounts and participants are immutable' USING ERRCODE='23514'; END IF;
    IF OLD.status IN ('finished','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Terminal soccer matches cannot reopen' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.status='playing' AND (TG_OP='INSERT' OR OLD.status<>'playing') THEN
    IF NEW.stake IS DISTINCT FROM NEW.host_offer OR coalesce(NEW.guest_stake,NEW.stake) IS DISTINCT FROM NEW.guest_offer OR
      (NEW.host_offer<>NEW.guest_offer AND (NEW.guest_stake IS NULL OR
        current_setting('target.two_player_offer_consent',true) IS DISTINCT FROM
          NEW.id::text||':'||NEW.host_offer::text||':'||NEW.guest_offer::text)) OR
      NOT EXISTS(SELECT 1 FROM target_private.two_player_wallet_events WHERE match_id=NEW.id AND phase='reserve'
        AND member_id=NEW.host_id AND delta=-NEW.stake) OR
      NOT EXISTS(SELECT 1 FROM target_private.two_player_wallet_events WHERE match_id=NEW.id AND phase='reserve'
        AND member_id=NEW.guest_id AND delta=-coalesce(NEW.guest_stake,NEW.stake)) THEN
      RAISE EXCEPTION 'Soccer funding must match current consent and both exact reserve receipts' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER two_player_funded_stakes BEFORE INSERT OR UPDATE ON target_private.two_player_matches
  FOR EACH ROW EXECUTE FUNCTION target_private.two_player_guard_funded_stakes();
REVOKE ALL ON FUNCTION target_private.two_player_validate_money(),target_private.two_player_guard_funded_stakes()
  FROM PUBLIC,anon,authenticated,service_role;

DO $helpers$
DECLARE definition text; marker text; replacement text;
BEGIN
  SELECT pg_get_functiondef('target_private.two_player_settle(uuid,text,text,text)'::regprocedure) INTO definition;
  marker:='CASE WHEN p_winner=''guest'' THEN m.escrow WHEN p_winner=''host'' THEN 0 ELSE m.stake END';
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Guest refund marker changed'; END IF;
  EXECUTE replace(definition,marker,'CASE WHEN p_winner=''guest'' THEN m.escrow WHEN p_winner=''host'' THEN 0 ELSE coalesce(m.guest_stake,m.stake) END');
  SELECT pg_get_functiondef('target_private.two_player_wallet(uuid)'::regprocedure) INTO definition;
  marker:='SELECT m.stake FROM target_private.two_player_participants';
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Own escrow marker changed'; END IF;
  EXECUTE replace(definition,marker,'SELECT CASE WHEN m.host_id=p_member THEN m.stake ELSE coalesce(m.guest_stake,m.stake) END FROM target_private.two_player_participants');
  SELECT pg_get_functiondef('target_private.two_player_match_dto(uuid,boolean)'::regprocedure) INTO definition;
  FOR marker,replacement IN SELECT * FROM (VALUES
    ('''offer'',m.host_offer,''formation''','''offer'',m.host_offer,''stake'',m.stake,''formation'''),
    ('''offer'',m.guest_offer,''formation''','''offer'',m.guest_offer,''stake'',CASE WHEN m.stake IS NULL THEN NULL ELSE coalesce(m.guest_stake,m.stake) END,''formation'''),
    ('''stake'',m.stake,''escrow'',m.escrow','''stake'',m.stake,''pot'',CASE WHEN m.stake IS NOT NULL THEN m.stake+coalesce(m.guest_stake,m.stake) WHEN m.status=''waiting'' THEN m.host_offer+coalesce(m.guest_offer,0) ELSE 0 END,''escrow'',m.escrow')
  ) changes(a,b) LOOP
    IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Stake DTO marker changed'; END IF;
    definition:=replace(definition,marker,replacement);
  END LOOP;
  EXECUTE definition;
END $helpers$;

DO $rpc$
DECLARE definition text; marker text; replacement text;
BEGIN
  SELECT pg_get_functiondef('public.two_player_rpc(text,text,jsonb)'::regprocedure) INTO definition;
  FOR marker,replacement IN SELECT * FROM (VALUES
    ('processing jsonb; response_value jsonb; allowed_keys text[]; is_mutation boolean;',
     'processing jsonb; response_value jsonb; allowed_keys text[]; is_mutation boolean; consent_key text;'),
    ('IF p_action=''ready'' THEN allowed_keys:=allowed_keys||ARRAY[''ready'']; END IF;',
     'IF p_action=''ready'' THEN allowed_keys:=allowed_keys||ARRAY[''ready'',''expectedHostOffer'',''expectedGuestOffer'']; END IF;'),
    ('  IF p_action IN (''input'',''resolve'') THEN'||chr(10)||'    IF jsonb_typeof(p_input->''round'')',
     '  IF p_action=''ready'' THEN'||chr(10)||
     '    IF (p_input?''expectedHostOffer'') IS DISTINCT FROM (p_input?''expectedGuestOffer'') THEN'||chr(10)||
     '      RETURN target_private.error_result(400,''INVALID_REQUEST'',''確認内容を選び直してください。''); END IF;'||chr(10)||
     '    IF p_input?''expectedHostOffer'' THEN'||chr(10)||
     '      FOREACH consent_key IN ARRAY ARRAY[''expectedHostOffer'',''expectedGuestOffer''] LOOP'||chr(10)||
     '        IF jsonb_typeof(p_input->consent_key) IS DISTINCT FROM ''number'' OR coalesce(p_input->>consent_key,'''')!~''^[1-9][0-9]{2,13}$'' THEN'||chr(10)||
     '          RETURN target_private.error_result(400,''INVALID_REQUEST'',''確認内容を選び直してください。''); END IF;'||chr(10)||
     '        IF (p_input->>consent_key)::bigint NOT BETWEEN 100 AND 10000000000000 OR (p_input->>consent_key)::bigint%100<>0 THEN'||chr(10)||
     '          RETURN target_private.error_result(400,''INVALID_REQUEST'',''確認内容を選び直してください。''); END IF;'||chr(10)||
     '      END LOOP;'||chr(10)||'    END IF;'||chr(10)||'  END IF;'||chr(10)||
     '  IF p_action IN (''input'',''resolve'') THEN'||chr(10)||'    IF jsonb_typeof(p_input->''round'')'),
    ('      IF (p_input->>''ready'')::boolean AND m.host_offer<>m.guest_offer THEN'||chr(10)||
     '        RETURN target_private.error_result(409,''STAKE_MISMATCH'',''2人の賭け金を同じ金額にしてください。''); END IF;',
     '      IF p_input?''expectedHostOffer'' AND ((p_input->>''expectedHostOffer'')::bigint<>m.host_offer OR'||chr(10)||
     '          (p_input->>''expectedGuestOffer'')::bigint<>m.guest_offer) THEN'||chr(10)||
     '        RETURN target_private.error_result(409,''STAKE_CHANGED'',''賭け額が変わりました。確認してください。''); END IF;'||chr(10)||
     '      IF (p_input->>''ready'')::boolean AND m.host_offer<>m.guest_offer THEN'||chr(10)||
     '        IF NOT(p_input?''expectedHostOffer'') THEN'||chr(10)||
     '          RETURN target_private.error_result(409,''STAKE_CONFIRMATION_REQUIRED'',''両方の賭け額を確認してください。''); END IF;'||chr(10)||
     '        PERFORM set_config(''target.two_player_offer_consent'',m.id::text||'':''||m.host_offer::text||'':''||m.guest_offer::text,true);'||chr(10)||
     '      END IF;'),
    ('          (p.total_points-p.spent_points<m.host_offer OR p.total_points+m.host_offer>10000000000000 OR'||chr(10)||
     '            p.casino_net-m.host_offer< -10000000000000 OR p.casino_net+m.host_offer>10000000000000 OR p.wallet_revision>=9999999999999)) THEN',
     '          (p.total_points-p.spent_points<CASE WHEN p.member_id=m.host_id THEN m.host_offer ELSE m.guest_offer END OR'||chr(10)||
     '            p.total_points+CASE WHEN p.member_id=m.host_id THEN m.guest_offer ELSE m.host_offer END>10000000000000 OR'||chr(10)||
     '            p.casino_net-CASE WHEN p.member_id=m.host_id THEN m.host_offer ELSE m.guest_offer END< -10000000000000 OR'||chr(10)||
     '            p.casino_net+CASE WHEN p.member_id=m.host_id THEN m.guest_offer ELSE m.host_offer END>10000000000000 OR p.wallet_revision>=9999999999999)) THEN'),
    ('PERFORM target_private.two_player_money(m.id,m.guest_id,''reserve'',''reserve'',-m.host_offer);',
     'PERFORM target_private.two_player_money(m.id,m.guest_id,''reserve'',''reserve'',-m.guest_offer);'),
    ('SET status=''playing'',stake=host_offer,escrow=2*host_offer,',
     'SET status=''playing'',stake=host_offer,guest_stake=guest_offer,escrow=host_offer+guest_offer,')
  ) changes(a,b) LOOP
    IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
      RAISE EXCEPTION 'Reviewed unequal-stake RPC marker changed: %',marker; END IF;
    definition:=replace(definition,marker,replacement);
  END LOOP;
  EXECUTE definition;
END $rpc$;

DO $preserved$
DECLARE before_state jsonb:=current_setting('target.unequal_stakes_before')::jsonb;
  after_state jsonb:='{}'::jsonb; relation text; digest text;
BEGIN
  FOR relation IN SELECT jsonb_object_keys(before_state) LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(md5((to_jsonb(t)-%L)::text),%L ORDER BY md5((to_jsonb(t)-%L)::text)),%L)) FROM target_private.%I t',
      CASE WHEN relation='two_player_matches' THEN 'guest_stake' ELSE '__absent_stake_field__' END,'',
      CASE WHEN relation='two_player_matches' THEN 'guest_stake' ELSE '__absent_stake_field__' END,'',relation) INTO digest;
    after_state:=after_state||jsonb_build_object(relation,digest);
  END LOOP;
  IF after_state IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'Unequal stakes migration changed existing data'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches WHERE guest_stake IS NOT NULL) THEN
    RAISE EXCEPTION 'Historical guest stake was unexpectedly backfilled'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches m LEFT JOIN LATERAL(
    SELECT coalesce(sum(delta),0) net FROM target_private.two_player_wallet_events e WHERE e.match_id=m.id) flow ON true
    WHERE flow.net+m.escrow<>0) THEN RAISE EXCEPTION 'Soccer escrow no longer reconciles'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
      IS DISTINCT FROM(l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet source projection no longer reconciles'; END IF;
END $preserved$;
COMMIT;
