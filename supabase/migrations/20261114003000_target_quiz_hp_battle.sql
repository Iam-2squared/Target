-- Target quiz HP battle (draft). Production migration requires isolated PostgreSQL QA
-- and explicit release approval. Existing 轟 wallets and soccer are not reset.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);

CREATE TABLE target_private.battle_presence (
 member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 session_hash text NOT NULL CHECK(session_hash ~ '^[a-f0-9]{64}$'),
 seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(member_id,session_hash)
);
CREATE INDEX battle_presence_seen ON target_private.battle_presence(seen_at);

CREATE TABLE target_private.battle_matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 host_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 guest_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 host_name text NOT NULL CHECK(length(host_name) BETWEEN 1 AND 20),
 guest_name text NOT NULL CHECK(length(guest_name) BETWEEN 1 AND 20),
 status text NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','setup','playing','finished','cancelled')),
 book text NOT NULL CHECK(book IN ('target1900','target1000','kobun400')),
 from_section smallint NOT NULL CHECK(from_section BETWEEN 1 AND 19),
 to_section smallint NOT NULL CHECK(to_section BETWEEN 1 AND 19),
 stake bigint NOT NULL CHECK(stake BETWEEN 100 AND 5000000000000 AND stake%100=0),
 initial_hp smallint NOT NULL CHECK(initial_hp IN (50,100,150,200,300)),
 host_hp smallint NOT NULL,guest_hp smallint NOT NULL,
 host_ready boolean NOT NULL DEFAULT false,guest_ready boolean NOT NULL DEFAULT false,
 offer_version integer NOT NULL DEFAULT 1 CHECK(offer_version BETWEEN 1 AND 1000000),
 host_sequence integer NOT NULL DEFAULT 0 CHECK(host_sequence BETWEEN 0 AND 1000),
 guest_sequence integer NOT NULL DEFAULT 0 CHECK(guest_sequence BETWEEN 0 AND 1000),
 escrow bigint NOT NULL DEFAULT 0 CHECK(escrow BETWEEN 0 AND 10000000000000 AND escrow%100=0),
 winner text CHECK(winner IN ('host','guest')),
 reason text CHECK(reason IN ('hp_zero','forfeit','idle_timeout','declined','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '3 minutes',
 settled_at timestamptz,
 CHECK(host_id<>guest_id),
 CHECK(from_section<=to_section),
 CHECK((book='target1900' AND to_section<=19) OR
       (book='target1000' AND to_section<=10) OR
       (book='kobun400' AND to_section<=4)),
 CHECK(host_hp BETWEEN 0 AND initial_hp AND guest_hp BETWEEN 0 AND initial_hp),
 CHECK((status='playing' AND host_ready AND guest_ready AND escrow=2*stake)
       OR (status<>'playing' AND escrow=0)),
 CHECK(status<>'finished' OR winner IS NOT NULL)
);
CREATE INDEX battle_matches_host_active ON target_private.battle_matches(host_id,updated_at DESC)
 WHERE status IN ('invited','setup','playing');
CREATE INDEX battle_matches_guest_active ON target_private.battle_matches(guest_id,updated_at DESC)
 WHERE status IN ('invited','setup','playing');
CREATE INDEX battle_matches_expiry ON target_private.battle_matches(expires_at)
 WHERE status IN ('invited','setup','playing');

CREATE TABLE target_private.battle_current_questions (
 match_id uuid NOT NULL REFERENCES target_private.battle_matches(id),
 member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 1000),
 question jsonb NOT NULL CHECK(jsonb_typeof(question)='object' AND pg_column_size(question)<=8192),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(match_id,member_id)
);
CREATE TABLE target_private.battle_answers (
 match_id uuid NOT NULL REFERENCES target_private.battle_matches(id),
 member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 question_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 1000),
 request_id uuid NOT NULL,
 choice_id uuid NOT NULL,
 correct boolean NOT NULL,
 damage smallint NOT NULL CHECK(damage IN (5,10)),
 correct_text text NOT NULL CHECK(length(correct_text) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(match_id,member_id,question_id),
 UNIQUE(member_id,request_id),
 UNIQUE(match_id,member_id,sequence)
);
CREATE TABLE target_private.battle_wallet_events (
 match_id uuid NOT NULL REFERENCES target_private.battle_matches(id),
 member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 phase text NOT NULL CHECK(phase IN ('reserve','settle')),
 kind text NOT NULL CHECK(kind IN ('stake','payout','refund','loss')),
 delta bigint NOT NULL CHECK(delta BETWEEN -5000000000000 AND 10000000000000 AND delta%100=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(match_id,member_id,phase)
);
CREATE INDEX battle_events_member ON target_private.battle_wallet_events(member_id,created_at);
CREATE TABLE target_private.battle_requests (
 member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 request_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('challenge','accept','decline','propose','ready','answer','cancel')),
 payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),
 match_id uuid NOT NULL REFERENCES target_private.battle_matches(id),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(member_id,request_id)
);
CREATE TABLE target_private.battle_rates (
 member_id uuid PRIMARY KEY REFERENCES target_private.profiles(member_id),
 minute_bucket bigint NOT NULL,
 calls integer NOT NULL CHECK(calls BETWEEN 0 AND 181),
 day_bucket bigint NOT NULL,
 challenges integer NOT NULL CHECK(challenges BETWEEN 0 AND 21)
);
ALTER TABLE target_private.battle_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.battle_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.battle_current_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.battle_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.battle_wallet_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.battle_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.battle_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE target_private.battle_presence,target_private.battle_matches,
 target_private.battle_current_questions,target_private.battle_answers,
 target_private.battle_wallet_events,target_private.battle_requests,target_private.battle_rates
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION target_private.battle_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Quiz battle permanent evidence cannot be altered' USING ERRCODE='42501'; END; $$;
CREATE TRIGGER battle_wallet_immutable BEFORE UPDATE OR DELETE ON target_private.battle_wallet_events
 FOR EACH ROW EXECUTE FUNCTION target_private.battle_immutable();
CREATE TRIGGER battle_answers_immutable BEFORE UPDATE OR DELETE ON target_private.battle_answers
 FOR EACH ROW EXECUTE FUNCTION target_private.battle_immutable();
CREATE TRIGGER battle_requests_immutable BEFORE UPDATE OR DELETE ON target_private.battle_requests
 FOR EACH ROW EXECUTE FUNCTION target_private.battle_immutable();

-- The existing reviewed finance projection accounts for every net 轟 event.
-- Fail closed rather than replacing or rebuilding the entire projection.
DO $projection$
DECLARE definition text; marker text;
BEGIN
 SELECT pg_get_functiondef('target_private.wallet_finance_projection(timestamptz)'::regprocedure) INTO definition;
 marker:='SELECT member_id,delta,created_at FROM target_private.two_player_wallet_events) a';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 OR
    position('target_private.battle_wallet_events' IN definition)>0 THEN
   RAISE EXCEPTION 'Reviewed Target finance projection has changed; migration not safe'; END IF;
 EXECUTE replace(definition,marker,
   'SELECT member_id,delta,created_at FROM target_private.two_player_wallet_events UNION ALL '||
   'SELECT member_id,delta,created_at FROM target_private.battle_wallet_events) a');
END; $projection$;


-- A player cannot reserve stakes in soccer and quiz HP battles simultaneously.
-- Both writers already take advisory lock 991101; triggers fence even old
-- compiled soccer writers that began before this migration committed.
CREATE FUNCTION target_private.battle_no_soccer_overlap()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='playing' AND OLD.status IS DISTINCT FROM 'playing' AND EXISTS(
   SELECT 1 FROM target_private.two_player_matches s WHERE s.status='playing'
    AND (s.host_id IN (NEW.host_id,NEW.guest_id) OR s.guest_id IN (NEW.host_id,NEW.guest_id))
 ) THEN RAISE EXCEPTION 'Participant has a funded soccer game' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER battle_no_soccer_overlap BEFORE UPDATE OF status ON target_private.battle_matches
 FOR EACH ROW EXECUTE FUNCTION target_private.battle_no_soccer_overlap();

CREATE FUNCTION target_private.soccer_no_battle_overlap()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='playing' AND OLD.status IS DISTINCT FROM 'playing' AND EXISTS(
   SELECT 1 FROM target_private.battle_matches b WHERE b.status='playing'
    AND (b.host_id IN (NEW.host_id,NEW.guest_id) OR b.guest_id IN (NEW.host_id,NEW.guest_id))
 ) THEN RAISE EXCEPTION 'Participant has a funded quiz HP battle' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER soccer_no_battle_overlap BEFORE UPDATE OF status ON target_private.two_player_matches
 FOR EACH ROW EXECUTE FUNCTION target_private.soccer_no_battle_overlap();

CREATE FUNCTION target_private.battle_wallet_headroom()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE pending bigint;
BEGIN
 SELECT coalesce(sum(m.escrow),0) INTO pending FROM target_private.battle_matches m
   WHERE m.status='playing' AND (m.host_id=NEW.member_id OR m.guest_id=NEW.member_id);
 IF pending>0 AND (NEW.total_points>10000000000000-pending OR
    NEW.casino_net>10000000000000-pending OR NEW.wallet_revision>=10000000000000) THEN
   RAISE EXCEPTION 'Wallet must preserve quiz battle payout headroom' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER battle_wallet_headroom BEFORE UPDATE OF total_points,casino_net,spent_points
 ON target_private.profiles FOR EACH ROW EXECUTE FUNCTION target_private.battle_wallet_headroom();

CREATE FUNCTION target_private.battle_dto(p_match uuid,p_member uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'id',m.id,'status',m.status,'book',m.book,'fromSection',m.from_section,'toSection',m.to_section,
  'stake',m.stake,'initialHp',m.initial_hp,'offerVersion',m.offer_version,
  'host',jsonb_build_object('id',m.host_id,'name',m.host_name,'ready',m.host_ready,'hp',m.host_hp),
  'guest',jsonb_build_object('id',m.guest_id,'name',m.guest_name,'ready',m.guest_ready,'hp',m.guest_hp),
  'myRole',CASE WHEN m.host_id=p_member THEN 'host' ELSE 'guest' END,
  'pot',CASE WHEN m.status='playing' THEN m.escrow WHEN m.status IN ('invited','setup') THEN 2*m.stake ELSE 0 END,
  'winner',m.winner,'reason',m.reason,'createdAt',m.created_at,'updatedAt',m.updated_at,'expiresAt',m.expires_at,
  'question',CASE WHEN m.status='playing' THEN
      (SELECT q.question-'correctChoiceId'-'correctText' FROM target_private.battle_current_questions q
       WHERE q.match_id=m.id AND q.member_id=p_member) ELSE NULL END)
 FROM target_private.battle_matches m WHERE m.id=p_match AND p_member IN (m.host_id,m.guest_id);
$$;

CREATE FUNCTION target_private.battle_money(p_match uuid,p_member uuid,p_phase text,p_kind text,p_delta bigint)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE m target_private.battle_matches%rowtype; wanted bigint;
BEGIN
 SELECT * INTO STRICT m FROM target_private.battle_matches WHERE id=p_match;
 IF p_member NOT IN (m.host_id,m.guest_id) THEN RAISE EXCEPTION 'Invalid battle financial actor'; END IF;
 IF p_phase='reserve' THEN
   IF m.status<>'playing' OR p_kind<>'stake' OR p_delta<>-m.stake THEN
     RAISE EXCEPTION 'Invalid battle reserve' USING ERRCODE='23514'; END IF;
 ELSIF p_phase='settle' THEN
   IF m.status NOT IN ('finished','cancelled') OR m.escrow<>0 THEN
     RAISE EXCEPTION 'Invalid battle settlement state' USING ERRCODE='23514'; END IF;
   wanted:=CASE WHEN m.status='cancelled' THEN m.stake
                WHEN (m.winner='host' AND m.host_id=p_member) OR
                     (m.winner='guest' AND m.guest_id=p_member) THEN 2*m.stake ELSE 0 END;
   IF p_delta<>wanted OR p_kind<>(CASE WHEN m.status='cancelled' THEN 'refund'
                           WHEN wanted>0 THEN 'payout' ELSE 'loss' END) THEN
     RAISE EXCEPTION 'Invalid battle settlement amount' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Invalid battle finance phase' USING ERRCODE='23514'; END IF;
 INSERT INTO target_private.battle_wallet_events(match_id,member_id,phase,kind,delta)
   VALUES(p_match,p_member,p_phase,p_kind,p_delta);
 IF p_delta<>0 THEN
   UPDATE target_private.profiles SET total_points=total_points+p_delta,
     casino_net=casino_net+p_delta,updated_at=now() WHERE member_id=p_member;
 END IF;
END; $$;

CREATE FUNCTION target_private.battle_settle(p_match uuid,p_winner text,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE m target_private.battle_matches%rowtype;
BEGIN
 SELECT * INTO STRICT m FROM target_private.battle_matches WHERE id=p_match FOR UPDATE;
 IF m.status IN ('finished','cancelled') THEN RETURN; END IF;
 IF p_winner IS NOT NULL AND (p_winner NOT IN ('host','guest') OR m.status<>'playing') THEN
   RAISE EXCEPTION 'Invalid battle winner'; END IF;
 UPDATE target_private.battle_matches
 SET status=CASE WHEN p_winner IS NULL THEN 'cancelled' ELSE 'finished' END,escrow=0,
     winner=p_winner,reason=p_reason,settled_at=clock_timestamp(),updated_at=clock_timestamp()
 WHERE id=p_match;
 IF m.status='playing' THEN
   PERFORM target_private.battle_money(p_match,m.host_id,'settle',
     CASE WHEN p_winner IS NULL THEN 'refund' WHEN p_winner='host' THEN 'payout' ELSE 'loss' END,
     CASE WHEN p_winner IS NULL THEN m.stake WHEN p_winner='host' THEN 2*m.stake ELSE 0 END);
   PERFORM target_private.battle_money(p_match,m.guest_id,'settle',
     CASE WHEN p_winner IS NULL THEN 'refund' WHEN p_winner='guest' THEN 'payout' ELSE 'loss' END,
     CASE WHEN p_winner IS NULL THEN m.stake WHEN p_winner='guest' THEN 2*m.stake ELSE 0 END);
 END IF;
 DELETE FROM target_private.battle_current_questions WHERE match_id=p_match;
END; $$;


-- A disconnected pair must not leave reserved wallets locked forever.
-- If pg_cron is available, process expiries every minute even without any
-- visiting browser. A local PostgreSQL test can call this function directly.
CREATE FUNCTION target_private.battle_expire(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE record_id uuid; expired integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION 'Invalid battle expiration batch limit' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(991101);
 FOR record_id IN SELECT id FROM target_private.battle_matches
   WHERE status IN ('invited','setup','playing') AND expires_at<=clock_timestamp()
   ORDER BY expires_at,id LIMIT p_limit FOR UPDATE LOOP
   PERFORM target_private.battle_settle(record_id,NULL,'idle_timeout');
   expired:=expired+1;
 END LOOP;
 RETURN expired;
END; $$;
REVOKE ALL ON FUNCTION target_private.battle_expire(integer)
 FROM PUBLIC,anon,authenticated,service_role;
DO $battle_schedule$
BEGIN
 IF to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
   PERFORM cron.schedule('target_quiz_hp_battle_expire','* * * * *',
     'SELECT target_private.battle_expire(100)');
 END IF;
END; $battle_schedule$;

-- One accepted answer per question and no client-provided grading.
CREATE FUNCTION public.target_battle_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 actor uuid; name_value text; session_value text; match_uuid uuid; target_uuid uuid;
 req_uuid uuid; previous target_private.battle_requests%rowtype; payload_digest text;
 m target_private.battle_matches%rowtype; q target_private.battle_current_questions%rowtype;
 selected_book text; from_value integer; to_value integer; stake_value bigint; hp_value integer;
 expected_value integer; now_value timestamptz:=clock_timestamp();
 minute_value bigint:=floor(extract(epoch FROM clock_timestamp())/60)::bigint;
 day_value bigint:=floor(extract(epoch FROM clock_timestamp())/86400)::bigint;
 rate_row target_private.battle_rates%rowtype;
 role_value text; is_correct boolean; answer_choice uuid; answer_id uuid;
 damage_value integer; hp_left integer; hp_right integer; received jsonb;
 output jsonb; status_value text; update_question jsonb;
BEGIN
 -- Credential gate runs before input parsing, locks, rates, presence or financial effects.
 IF p_secret IS NULL OR length(p_secret) NOT BETWEEN 32 AND 256 OR NOT EXISTS(
   SELECT 1 FROM target_private.server_credentials WHERE singleton
     AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
   RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。');
 END IF;
 IF p_action IS NULL OR p_action NOT IN
   ('lobby','state','next','challenge','accept','decline','propose','ready','answer','cancel')
   OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR pg_column_size(p_input)>12288 OR
   coalesce(p_input->>'memberId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
   jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 20 OR
   coalesce(p_input->>'sessionHash','') !~ '^[0-9a-f]{64}$' THEN
   RETURN target_private.error_result(400,'INVALID_BATTLE_REQUEST','送信内容を確認してください。');
 END IF;
 actor:=(p_input->>'memberId')::uuid;name_value:=btrim(p_input->>'name');session_value:=p_input->>'sessionHash';
 IF NOT EXISTS(SELECT 1 FROM target_private.profiles WHERE member_id=actor) THEN
   RETURN target_private.error_result(401,'BATTLE_LOGIN_REQUIRED','ログインし直してください。'); END IF;
 IF p_action IN ('challenge','accept','decline','propose','ready','answer','cancel') THEN
   IF coalesce(p_input->>'requestId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' THEN
     RETURN target_private.error_result(400,'INVALID_BATTLE_REQUEST','操作をやり直してください。'); END IF;
   req_uuid:=(p_input->>'requestId')::uuid;
 END IF;
 IF p_action IN ('state','next','accept','decline','propose','ready','answer','cancel') THEN
   IF coalesce(p_input->>'matchId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' THEN
     RETURN target_private.error_result(400,'INVALID_BATTLE_REQUEST','対戦を選び直してください。'); END IF;
   match_uuid:=(p_input->>'matchId')::uuid;
 END IF;
 IF p_action IN ('challenge','propose') THEN
   IF jsonb_typeof(p_input->'book') IS DISTINCT FROM 'string'
      OR p_input->>'book' NOT IN ('target1900','target1000','kobun400')
      OR coalesce(p_input->>'fromSection','') !~ '^[0-9]{1,2}$'
      OR coalesce(p_input->>'toSection','') !~ '^[0-9]{1,2}$'
      OR coalesce(p_input->>'initialHp','') !~ '^[0-9]{2,3}$'
      OR coalesce(p_input->>'stake','') !~ '^[0-9]{3,13}$' THEN
     RETURN target_private.error_result(400,'INVALID_SETTINGS','対戦設定を確認してください。'); END IF;
   selected_book:=p_input->>'book';from_value:=(p_input->>'fromSection')::integer;
   to_value:=(p_input->>'toSection')::integer;stake_value:=(p_input->>'stake')::bigint;
   hp_value:=(p_input->>'initialHp')::integer;
   IF from_value<1 OR to_value<from_value OR
      to_value>(CASE selected_book WHEN 'target1900' THEN 19 WHEN 'target1000' THEN 10 ELSE 4 END) OR
      stake_value<100 OR stake_value>5000000000000 OR stake_value%100<>0 OR
      hp_value NOT IN (50,100,150,200,300) THEN
     RETURN target_private.error_result(400,'INVALID_SETTINGS','対戦設定を確認してください。'); END IF;
 END IF;
 IF p_action IN ('propose','ready') THEN
   IF coalesce(p_input->>'expectedVersion','') !~ '^[0-9]{1,7}$' THEN
     RETURN target_private.error_result(400,'INVALID_SETTINGS','設定を読み直してください。'); END IF;
   expected_value:=(p_input->>'expectedVersion')::integer;
 END IF;
 IF p_action='challenge' THEN
   IF coalesce(p_input->>'targetId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' THEN
     RETURN target_private.error_result(400,'INVALID_BATTLE_REQUEST','相手を選び直してください。'); END IF;
   target_uuid:=(p_input->>'targetId')::uuid;
 END IF;
 IF p_action='answer' THEN
   IF coalesce(p_input->>'questionId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
      coalesce(p_input->>'choiceId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' THEN
     RETURN target_private.error_result(400,'INVALID_ANSWER','選択肢を確認してください。'); END IF;
   answer_id:=(p_input->>'questionId')::uuid;answer_choice:=(p_input->>'choiceId')::uuid;
 END IF;
 -- State is read-only. 'next' creates only a server-selected question.
 IF p_action='state' THEN
   SELECT * INTO m FROM target_private.battle_matches WHERE id=match_uuid;
   IF m.id IS NULL OR actor NOT IN (m.host_id,m.guest_id) THEN
     RETURN target_private.error_result(404,'BATTLE_NOT_FOUND','対戦が見つかりません。'); END IF;
   RETURN jsonb_build_object('ok',true,'match',target_private.battle_dto(m.id,actor),
     'wallet',target_private.games_wallet(actor));
 END IF;

 PERFORM pg_advisory_xact_lock(991101);
 IF p_action<>'next' THEN
   INSERT INTO target_private.battle_rates(member_id,minute_bucket,calls,day_bucket,challenges)
   VALUES(actor,minute_value,1,day_value,CASE WHEN p_action='challenge' THEN 1 ELSE 0 END)
   ON CONFLICT(member_id) DO UPDATE SET
     minute_bucket=minute_value,
     calls=CASE WHEN battle_rates.minute_bucket=minute_value THEN least(battle_rates.calls+1,181) ELSE 1 END,
     day_bucket=day_value,
     challenges=CASE WHEN battle_rates.day_bucket=day_value
       THEN least(battle_rates.challenges+CASE WHEN p_action='challenge' THEN 1 ELSE 0 END,21)
       ELSE CASE WHEN p_action='challenge' THEN 1 ELSE 0 END END
   RETURNING * INTO rate_row;
   IF rate_row.calls>180 OR rate_row.challenges>20 THEN
     RETURN target_private.error_result(429,'BATTLE_RATE_LIMIT','操作が多いため、少し待ってください。'); END IF;
 END IF;

 IF p_action='lobby' THEN
   DELETE FROM target_private.battle_presence WHERE seen_at<clock_timestamp()-interval '100 seconds';
   INSERT INTO target_private.battle_presence(member_id,session_hash,seen_at)
     VALUES(actor,session_value,clock_timestamp())
   ON CONFLICT(member_id,session_hash) DO UPDATE SET seen_at=excluded.seen_at;
   -- Expiration is fixed by accepted actions; polling never renews it.
   FOR m IN SELECT * FROM target_private.battle_matches
      WHERE status IN ('invited','setup','playing') AND expires_at<=clock_timestamp()
        AND (host_id=actor OR guest_id=actor) ORDER BY expires_at LIMIT 3 FOR UPDATE LOOP
     PERFORM target_private.battle_settle(m.id,NULL,'idle_timeout');
   END LOOP;
   SELECT jsonb_build_object('ok',true,
     'wallet',target_private.games_wallet(actor),
     'online',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.member_id,'name',p.name)
       ORDER BY lower(p.name),p.member_id)
       FROM (SELECT DISTINCT member_id FROM target_private.battle_presence
         WHERE seen_at>=clock_timestamp()-interval '90 seconds' AND member_id<>actor) current
       JOIN target_private.profiles p ON p.member_id=current.member_id),'[]'::jsonb),
     'incoming',coalesce((SELECT jsonb_agg(target_private.battle_dto(x.id,actor) ORDER BY x.created_at)
       FROM (SELECT id,created_at FROM target_private.battle_matches
         WHERE guest_id=actor AND status='invited' AND expires_at>clock_timestamp()
         ORDER BY created_at LIMIT 5) x),'[]'::jsonb),
     'outgoing',coalesce((SELECT jsonb_agg(target_private.battle_dto(x.id,actor) ORDER BY x.created_at)
       FROM (SELECT id,created_at FROM target_private.battle_matches
         WHERE host_id=actor AND status='invited' AND expires_at>clock_timestamp()
         ORDER BY created_at LIMIT 5) x),'[]'::jsonb),
     'match',(SELECT target_private.battle_dto(x.id,actor)
       FROM target_private.battle_matches x WHERE x.status IN ('setup','playing')
       AND (x.host_id=actor OR x.guest_id=actor) ORDER BY x.created_at DESC LIMIT 1))
     INTO output;
   RETURN output;
 END IF;

 IF p_action='next' THEN
   SELECT * INTO m FROM target_private.battle_matches WHERE id=match_uuid FOR UPDATE;
   IF m.id IS NULL OR actor NOT IN (m.host_id,m.guest_id) THEN
     RETURN target_private.error_result(404,'BATTLE_NOT_FOUND','対戦が見つかりません。'); END IF;
   IF m.status<>'playing' THEN
     RETURN jsonb_build_object('ok',true,'match',target_private.battle_dto(match_uuid,actor),
       'wallet',target_private.games_wallet(actor)); END IF;
   IF NOT EXISTS(SELECT 1 FROM target_private.battle_current_questions WHERE match_id=m.id AND member_id=actor) THEN
     update_question:=p_input->'question';
     IF jsonb_typeof(update_question) IS DISTINCT FROM 'object' OR pg_column_size(update_question)>8192 OR
       jsonb_typeof(update_question->'choices') IS DISTINCT FROM 'array' OR
       jsonb_array_length(update_question->'choices')<>4 OR
       coalesce(update_question->>'id','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
       coalesce(update_question->>'correctChoiceId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
       jsonb_typeof(update_question->'correctText') IS DISTINCT FROM 'string' OR
       length(update_question->>'correctText') NOT BETWEEN 1 AND 2000 OR
       length(coalesce(update_question->>'prompt','')) NOT BETWEEN 1 AND 3000 OR
       coalesce(update_question->>'number','') !~ '^[0-9]{1,4}$' THEN
       RETURN target_private.error_result(400,'INVALID_QUESTION','出題を確認できませんでした。'); END IF;
     IF (update_question->>'number')::integer NOT BETWEEN ((m.from_section-1)*100+1) AND m.to_section*100 OR
        (SELECT count(*) FROM jsonb_array_elements(update_question->'choices') c
          WHERE coalesce(c->>'id','') ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
          AND length(coalesce(c->>'text','')) BETWEEN 1 AND 3000)<>4 OR
        (SELECT count(*) FROM jsonb_array_elements(update_question->'choices') c
          WHERE c->>'id'=update_question->>'correctChoiceId')<>1 THEN
       RETURN target_private.error_result(400,'INVALID_QUESTION','選択肢を確認できませんでした。'); END IF;
     IF (CASE WHEN actor=m.host_id THEN m.host_sequence ELSE m.guest_sequence END)>=1000 THEN
       PERFORM target_private.battle_settle(m.id,NULL,'idle_timeout');
     ELSE
       UPDATE target_private.battle_matches SET
         host_sequence=host_sequence+CASE WHEN actor=host_id THEN 1 ELSE 0 END,
         guest_sequence=guest_sequence+CASE WHEN actor=guest_id THEN 1 ELSE 0 END
         WHERE id=m.id RETURNING * INTO m;
       INSERT INTO target_private.battle_current_questions(match_id,member_id,sequence,question)
         VALUES(m.id,actor,CASE WHEN actor=m.host_id THEN m.host_sequence ELSE m.guest_sequence END,update_question);
     END IF;
   END IF;
   RETURN jsonb_build_object('ok',true,'match',target_private.battle_dto(match_uuid,actor),
       'wallet',target_private.games_wallet(actor));
 END IF;

 -- Mutations are idempotent even if another player has since changed the match.
 payload_digest:=encode(sha256(convert_to(
   (jsonb_build_object('action',p_action,'input',p_input-'memberId'-'name'-'sessionHash'))::text,'UTF8')),'hex');
 SELECT * INTO previous FROM target_private.battle_requests WHERE member_id=actor AND request_id=req_uuid;
 IF previous.request_id IS NOT NULL THEN
   IF previous.action<>p_action OR previous.payload_hash<>payload_digest THEN
     RETURN target_private.error_result(409,'BATTLE_REQUEST_CONFLICT','この操作は内容が変更されています。'); END IF;
   RETURN (previous.response-'match'-'wallet')||jsonb_build_object(
     'match',target_private.battle_dto(previous.match_id,actor),
     'wallet',target_private.games_wallet(actor),'replayed',true);
 END IF;

 IF p_action='challenge' THEN
   IF actor=target_uuid OR NOT EXISTS(SELECT 1 FROM target_private.battle_presence
       WHERE member_id=target_uuid AND seen_at>=clock_timestamp()-interval '90 seconds') THEN
     RETURN target_private.error_result(409,'BATTLE_PLAYER_OFFLINE','相手がオンラインではありません。'); END IF;
   IF EXISTS(SELECT 1 FROM target_private.battle_matches WHERE status IN ('invited','setup','playing')
      AND (host_id IN (actor,target_uuid) OR guest_id IN (actor,target_uuid))) THEN
     RETURN target_private.error_result(409,'BATTLE_PLAYER_BUSY','どちらかが別の対戦中です。'); END IF;
   IF (SELECT count(*) FROM target_private.battle_matches WHERE created_at>=date_trunc('day',clock_timestamp()))>=100 THEN
     RETURN target_private.error_result(429,'BATTLE_DAILY_LIMIT','本日の対戦作成上限です。'); END IF;
   INSERT INTO target_private.battle_matches(host_id,guest_id,host_name,guest_name,
       book,from_section,to_section,stake,initial_hp,host_hp,guest_hp)
     SELECT actor,target_uuid,name_value,p.name,selected_book,from_value,to_value,
       stake_value,hp_value,hp_value,hp_value FROM target_private.profiles p WHERE p.member_id=target_uuid
     RETURNING * INTO m;
   IF m.id IS NULL THEN RETURN target_private.error_result(404,'BATTLE_PLAYER_NOT_FOUND','相手が見つかりません。'); END IF;
 ELSIF p_action IN ('accept','decline','propose','ready','answer','cancel') THEN
   SELECT * INTO m FROM target_private.battle_matches WHERE id=match_uuid FOR UPDATE;
   IF m.id IS NULL OR actor NOT IN (m.host_id,m.guest_id) THEN
     RETURN target_private.error_result(404,'BATTLE_NOT_FOUND','対戦が見つかりません。'); END IF;
   role_value:=CASE WHEN actor=m.host_id THEN 'host' ELSE 'guest' END;
   IF m.expires_at<=clock_timestamp() AND m.status IN ('invited','setup','playing') THEN
     PERFORM target_private.battle_settle(m.id,NULL,'idle_timeout');
     RETURN target_private.error_result(409,'BATTLE_EXPIRED','対戦の期限が切れました。');
   END IF;
   IF p_action='accept' THEN
     IF m.status<>'invited' OR role_value<>'guest' THEN
       RETURN target_private.error_result(409,'BATTLE_NOT_INVITED','この招待は受けられません。'); END IF;
     UPDATE target_private.battle_matches SET status='setup',
       expires_at=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp()
       WHERE id=m.id;
   ELSIF p_action='decline' THEN
     IF m.status<>'invited' OR role_value<>'guest' THEN
       RETURN target_private.error_result(409,'BATTLE_NOT_INVITED','この招待は取り消せません。'); END IF;
     PERFORM target_private.battle_settle(m.id,NULL,'declined');
   ELSIF p_action='propose' THEN
     IF m.status<>'setup' OR m.offer_version<>expected_value OR m.offer_version>=1000000 THEN
       RETURN target_private.error_result(409,'BATTLE_SETTINGS_CHANGED','設定を読み直してください。'); END IF;
     UPDATE target_private.battle_matches SET book=selected_book,from_section=from_value,
       to_section=to_value,stake=stake_value,initial_hp=hp_value,host_hp=hp_value,guest_hp=hp_value,
       host_ready=false,guest_ready=false,offer_version=offer_version+1,
       updated_at=clock_timestamp(),expires_at=clock_timestamp()+interval '10 minutes' WHERE id=m.id;
   ELSIF p_action='ready' THEN
     IF m.status<>'setup' OR m.offer_version<>expected_value THEN
       RETURN target_private.error_result(409,'BATTLE_SETTINGS_CHANGED','設定を読み直してください。'); END IF;
     IF (role_value='host' AND m.host_ready) OR (role_value='guest' AND m.guest_ready) THEN
       RETURN target_private.error_result(409,'BATTLE_ALREADY_READY','承認済みです。'); END IF;
     IF (role_value='host' AND m.guest_ready) OR (role_value='guest' AND m.host_ready) THEN
       -- Both wallets are locked in stable UUID order before either reserve.
       PERFORM 1 FROM target_private.profiles p WHERE p.member_id IN (m.host_id,m.guest_id)
         ORDER BY p.member_id FOR UPDATE;
       IF (SELECT count(*) FROM target_private.profiles p WHERE p.member_id IN (m.host_id,m.guest_id))<>2 OR
          EXISTS(SELECT 1 FROM target_private.profiles p WHERE p.member_id IN (m.host_id,m.guest_id) AND
            (p.total_points-p.spent_points<m.stake OR
             p.total_points-m.stake+2*m.stake>10000000000000 OR
             p.casino_net-m.stake+2*m.stake>10000000000000 OR
             p.casino_net-m.stake< -10000000000000 OR
             p.wallet_revision>=9999999999999)) THEN
         RETURN target_private.error_result(409,'BATTLE_INSUFFICIENT_BALANCE','2人の残高または受取上限が不足しています。');
       END IF;
       IF EXISTS(SELECT 1 FROM target_private.two_player_matches s WHERE s.status='playing'
          AND (s.host_id IN (m.host_id,m.guest_id) OR s.guest_id IN (m.host_id,m.guest_id))) THEN
         RETURN target_private.error_result(409,'BATTLE_SOCCER_BUSY','2playerの対戦中は開始できません。');
       END IF;
       UPDATE target_private.battle_matches SET status='playing',escrow=2*stake,
          host_ready=true,guest_ready=true,updated_at=clock_timestamp(),
          expires_at=clock_timestamp()+interval '10 minutes' WHERE id=m.id;
       PERFORM target_private.battle_money(m.id,m.host_id,'reserve','stake',-m.stake);
       PERFORM target_private.battle_money(m.id,m.guest_id,'reserve','stake',-m.stake);
     ELSE
       UPDATE target_private.battle_matches SET host_ready=host_ready OR role_value='host',
         guest_ready=guest_ready OR role_value='guest',
         updated_at=clock_timestamp(),expires_at=clock_timestamp()+interval '10 minutes' WHERE id=m.id;
     END IF;
   ELSIF p_action='answer' THEN
     IF m.status<>'playing' THEN
       RETURN target_private.error_result(409,'BATTLE_NOT_PLAYING','この試合は終了しています。'); END IF;
     SELECT * INTO q FROM target_private.battle_current_questions
       WHERE match_id=m.id AND member_id=actor FOR UPDATE;
     IF q.match_id IS NULL OR coalesce(q.question->>'id','')<>(answer_id::text) THEN
       RETURN target_private.error_result(409,'BATTLE_QUESTION_CHANGED','問題を読み直してください。'); END IF;
     IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.question->'choices') c
       WHERE c->>'id'=answer_choice::text) THEN
       RETURN target_private.error_result(400,'BATTLE_INVALID_CHOICE','選択肢を確認してください。'); END IF;
     is_correct:=q.question->>'correctChoiceId'=answer_choice::text;
     damage_value:=CASE WHEN is_correct THEN 5 ELSE 10 END;
     hp_left:=greatest(0,m.host_hp-(CASE WHEN (is_correct AND role_value='guest') OR
       (NOT is_correct AND role_value='host') THEN damage_value ELSE 0 END));
     hp_right:=greatest(0,m.guest_hp-(CASE WHEN (is_correct AND role_value='host') OR
       (NOT is_correct AND role_value='guest') THEN damage_value ELSE 0 END));
     INSERT INTO target_private.battle_answers(match_id,member_id,question_id,sequence,
       request_id,choice_id,correct,damage,correct_text)
       VALUES(m.id,actor,answer_id,q.sequence,req_uuid,answer_choice,is_correct,damage_value,
         q.question->>'correctText');
     DELETE FROM target_private.battle_current_questions WHERE match_id=m.id AND member_id=actor;
     UPDATE target_private.battle_matches SET host_hp=hp_left,guest_hp=hp_right,
       updated_at=clock_timestamp(),expires_at=clock_timestamp()+interval '10 minutes' WHERE id=m.id;
     IF hp_left=0 OR hp_right=0 THEN
       PERFORM target_private.battle_settle(m.id,CASE WHEN hp_left=0 THEN 'guest' ELSE 'host' END,'hp_zero');
     END IF;
     received:=jsonb_build_object('correct',is_correct,'damage',damage_value,
       'correctText',q.question->>'correctText','questionId',answer_id);
   ELSIF p_action='cancel' THEN
     IF m.status IN ('invited','setup') THEN PERFORM target_private.battle_settle(m.id,NULL,'cancelled');
     ELSIF m.status='playing' THEN
       PERFORM target_private.battle_settle(m.id,CASE WHEN role_value='host' THEN 'guest' ELSE 'host' END,'forfeit');
     ELSE RETURN target_private.error_result(409,'BATTLE_NOT_ACTIVE','終了済みです。'); END IF;
   END IF;
 END IF;
 output:=jsonb_build_object('ok',true,'match',target_private.battle_dto(m.id,actor),
   'wallet',target_private.games_wallet(actor))
   ||CASE WHEN received IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('answer',received) END;
 INSERT INTO target_private.battle_requests(member_id,request_id,action,payload_hash,match_id,response)
   VALUES(actor,req_uuid,p_action,payload_digest,m.id,output);
 RETURN output;
END; $$;
REVOKE ALL ON FUNCTION public.target_battle_rpc(text,text,jsonb) FROM PUBLIC,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.target_battle_rpc(text,text,jsonb) TO anon;
COMMENT ON FUNCTION public.target_battle_rpc(text,text,jsonb) IS
 'KGS-verified virtual 轟 quiz HP battle. Server secret required. Two approvals reserve both stakes atomically; answers and wallet settlement are server authoritative.';
COMMIT;
