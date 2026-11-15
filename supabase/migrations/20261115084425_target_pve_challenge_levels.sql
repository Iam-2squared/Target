-- Independent PvE challenge. No stakes or existing game/frame state are changed.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
CREATE TABLE target_private.challenge_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 level smallint NOT NULL CHECK(level BETWEEN 1 AND 10),
 status text NOT NULL DEFAULT 'playing' CHECK(status IN ('playing','paused','won','lost','aborted')),
 player_hp integer NOT NULL,enemy_hp integer NOT NULL,
 streak integer NOT NULL DEFAULT 0 CHECK(streak>=0),
 correct_count integer NOT NULL DEFAULT 0 CHECK(correct_count>=0),
 wrong_count integer NOT NULL DEFAULT 0 CHECK(wrong_count>=0),
 sequence integer NOT NULL DEFAULT 0 CHECK(sequence>=0),
 questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(questions)='array' AND jsonb_array_length(questions)<=10),
 next_attack_at timestamptz,
 attack_remaining_ms integer NOT NULL DEFAULT 2000 CHECK(attack_remaining_ms BETWEEN 0 AND 2000),
 reward bigint NOT NULL DEFAULT 0 CHECK(reward BETWEEN 0 AND 1000000),
 badge_awarded boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(player_hp BETWEEN 0 AND 100+50*(level-1)),
 CHECK(enemy_hp BETWEEN 0 AND 100*level),
 CHECK(status='playing' OR next_attack_at IS NULL),
 CHECK(status<>'won' OR (enemy_hp=0 AND reward=level*100000))
);
CREATE UNIQUE INDEX challenge_one_active_run ON target_private.challenge_runs(member_id) WHERE status IN ('playing','paused');
CREATE TABLE target_private.challenge_badges (
 member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 level smallint NOT NULL CHECK(level BETWEEN 1 AND 10),
 run_id uuid NOT NULL UNIQUE REFERENCES target_private.challenge_runs(id),
 earned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(member_id,level)
);
CREATE TABLE target_private.challenge_reward_events (
 run_id uuid PRIMARY KEY REFERENCES target_private.challenge_runs(id),
 member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 level smallint NOT NULL CHECK(level BETWEEN 1 AND 10),
 amount bigint NOT NULL CHECK(amount=level*100000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX challenge_rewards_member ON target_private.challenge_reward_events(member_id,created_at);
CREATE TABLE target_private.challenge_requests (
 member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),request_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('start','answer','pause','resume','abort')),
 payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),
 run_id uuid NOT NULL REFERENCES target_private.challenge_runs(id),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND pg_column_size(response)<=4096),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(member_id,request_id)
);
CREATE TABLE target_private.challenge_rates (
 member_id uuid PRIMARY KEY REFERENCES target_private.profiles(member_id),
 minute_bucket bigint NOT NULL,calls integer NOT NULL CHECK(calls BETWEEN 1 AND 601)
);
ALTER TABLE target_private.challenge_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.challenge_badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.challenge_reward_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.challenge_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.challenge_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON target_private.challenge_runs,target_private.challenge_badges,target_private.challenge_reward_events,
 target_private.challenge_requests,target_private.challenge_rates FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER challenge_rewards_immutable BEFORE UPDATE OR DELETE ON target_private.challenge_reward_events
 FOR EACH ROW EXECUTE FUNCTION target_private.battle_immutable();
CREATE TRIGGER challenge_badges_immutable BEFORE UPDATE OR DELETE ON target_private.challenge_badges
 FOR EACH ROW EXECUTE FUNCTION target_private.battle_immutable();
CREATE TRIGGER challenge_requests_immutable BEFORE UPDATE OR DELETE ON target_private.challenge_requests
 FOR EACH ROW EXECUTE FUNCTION target_private.battle_immutable();

-- Account mutable question blocks and permanent receipts in the existing shared
-- 100 MiB budget. Capacity exceptions roll the complete RPC transaction back.
CREATE FUNCTION target_private.challenge_storage_charge()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE difference bigint; used bigint;
BEGIN
 difference:=CASE WHEN TG_OP='DELETE' THEN 0 ELSE pg_column_size(to_jsonb(NEW))+128 END-
  CASE WHEN TG_OP='INSERT' THEN 0 ELSE pg_column_size(to_jsonb(OLD))+128 END;
 SELECT logical_bytes INTO used FROM target_private.system_state WHERE singleton FOR UPDATE;
 IF used IS NULL OR used+difference>104857600 OR used+difference<0 THEN
  RAISE EXCEPTION 'Challenge storage capacity reached' USING ERRCODE='54000'; END IF;
 UPDATE target_private.system_state SET logical_bytes=logical_bytes+difference WHERE singleton;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
REVOKE ALL ON FUNCTION target_private.challenge_storage_charge() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER challenge_runs_storage AFTER INSERT OR UPDATE OR DELETE ON target_private.challenge_runs
 FOR EACH ROW EXECUTE FUNCTION target_private.challenge_storage_charge();
CREATE TRIGGER challenge_badges_storage AFTER INSERT OR UPDATE OR DELETE ON target_private.challenge_badges
 FOR EACH ROW EXECUTE FUNCTION target_private.challenge_storage_charge();
CREATE TRIGGER challenge_rewards_storage AFTER INSERT OR UPDATE OR DELETE ON target_private.challenge_reward_events
 FOR EACH ROW EXECUTE FUNCTION target_private.challenge_storage_charge();
CREATE TRIGGER challenge_requests_storage AFTER INSERT OR UPDATE OR DELETE ON target_private.challenge_requests
 FOR EACH ROW EXECUTE FUNCTION target_private.challenge_storage_charge();
CREATE TRIGGER challenge_rates_storage AFTER INSERT OR UPDATE OR DELETE ON target_private.challenge_rates
 FOR EACH ROW EXECUTE FUNCTION target_private.challenge_storage_charge();

CREATE FUNCTION target_private.challenge_dto(p_run uuid,p_member uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',r.id,'level',r.level,'status',r.status,
 'playerHp',r.player_hp,'playerMaxHp',100+50*(r.level-1),'enemyHp',r.enemy_hp,'enemyMaxHp',100*r.level,
 'attackIntervalMs',CASE WHEN r.level=10 THEN 1000 ELSE 2000-100*(r.level-1) END,
 'attackDamage',CASE WHEN r.level=10 THEN 15 ELSE 5+(r.level-1) END,
 'streak',r.streak,'correctCount',r.correct_count,'wrongCount',r.wrong_count,
 'questionSequence',r.sequence,
 'question',CASE WHEN r.status='playing' AND jsonb_array_length(r.questions)>0 THEN
    (r.questions->0)-'correctChoiceId'-'correctText' ELSE NULL END,
 'nextAttackInMs',CASE WHEN r.status='playing' AND r.next_attack_at IS NOT NULL THEN
    greatest(0,ceil(extract(epoch FROM (r.next_attack_at-clock_timestamp()))*1000)::integer)
    ELSE r.attack_remaining_ms END,
 'serverNow',clock_timestamp(),'createdAt',r.created_at,'updatedAt',r.updated_at,
 'reward',r.reward,'badgeAwarded',r.badge_awarded)
 FROM target_private.challenge_runs r WHERE r.id=p_run AND r.member_id=p_member;
$$;
REVOKE ALL ON FUNCTION target_private.challenge_dto(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Lazy server clock: every request applies all enemy attacks due by database time.
-- The clock runs only with an issued question, and pauses preserve the fractional interval.
CREATE FUNCTION target_private.challenge_tick(p_run uuid,p_now timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r target_private.challenge_runs%rowtype; ticks bigint; pace integer; hit integer;
BEGIN
 SELECT * INTO r FROM target_private.challenge_runs WHERE id=p_run FOR UPDATE;
 IF r.status<>'playing' OR r.next_attack_at IS NULL OR r.next_attack_at>p_now THEN RETURN; END IF;
 pace:=CASE WHEN r.level=10 THEN 1000 ELSE 2000-100*(r.level-1) END;
 hit:=CASE WHEN r.level=10 THEN 15 ELSE 5+(r.level-1) END;
 ticks:=1+floor(extract(epoch FROM (p_now-r.next_attack_at))*1000/pace)::bigint;
 IF ticks*hit>=r.player_hp THEN
  UPDATE target_private.challenge_runs SET player_hp=0,status='lost',questions='[]',next_attack_at=NULL,
   updated_at=p_now WHERE id=p_run;
 ELSE
  UPDATE target_private.challenge_runs SET player_hp=player_hp-(ticks*hit)::integer,
   next_attack_at=next_attack_at+ticks*pace*interval '1 millisecond',updated_at=p_now WHERE id=p_run;
 END IF;
END; $$;
REVOKE ALL ON FUNCTION target_private.challenge_tick(uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.target_challenge_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $challenge$
DECLARE
 actor uuid; run_uuid uuid; request_uuid uuid; q_uuid uuid; choice_uuid uuid;
 r target_private.challenge_runs%rowtype; old_request target_private.challenge_requests%rowtype;
 p target_private.profiles%rowtype; question jsonb; candidate jsonb; choice jsonb;
 keys text[]; request_hash text; output jsonb; answer_data jsonb; candidates jsonb;
 now_at timestamptz; minute_value bigint; call_count integer; chosen_level integer;
 pace integer; hit integer; max_section integer; sections integer; heal integer:=0; enemy_heal integer:=0;
 accepted boolean; bonus boolean:=false; awarded boolean:=false; damage integer;
 max_income bigint:=10000000000000; pending_payout bigint;
BEGIN
 IF p_secret IS NULL OR length(p_secret) NOT BETWEEN 32 AND 256 OR NOT EXISTS(
  SELECT 1 FROM target_private.server_credentials WHERE singleton AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
  RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。'); END IF;
 IF p_action IS NULL OR p_action NOT IN ('map','state','start','next','answer','pause','resume','abort') OR
  p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR pg_column_size(p_input)>90000 THEN
  RETURN target_private.error_result(400,'INVALID_CHALLENGE_REQUEST','送信内容を確認してください。'); END IF;
 keys:=ARRAY['memberId','name','sessionHash'];
 IF p_action='start' THEN keys:=keys||ARRAY['requestId','level'];
 ELSIF p_action='state' THEN keys:=keys||ARRAY['runId'];
 ELSIF p_action='next' THEN keys:=keys||ARRAY['runId','questions'];
 ELSIF p_action='answer' THEN keys:=keys||ARRAY['requestId','runId','questionId','choiceId'];
 ELSIF p_action<>'map' THEN keys:=keys||ARRAY['requestId','runId']; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>array_length(keys,1) OR
  EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE NOT(k=ANY(keys))) OR
  coalesce(p_input->>'memberId','')!~'^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
  coalesce(p_input->>'sessionHash','')!~'^[a-f0-9]{64}$' OR
  jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 20 THEN
  RETURN target_private.error_result(400,'INVALID_CHALLENGE_REQUEST','送信内容を確認してください。'); END IF;
 actor:=(p_input->>'memberId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM target_private.profiles WHERE member_id=actor) THEN
  RETURN target_private.error_result(401,'AUTHENTICATION_REQUIRED','ログインし直してください。'); END IF;
 IF p_action NOT IN ('map','start') THEN
  IF coalesce(p_input->>'runId','')!~'^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' THEN
   RETURN target_private.error_result(400,'INVALID_CHALLENGE_REQUEST','挑戦を選び直してください。'); END IF;
  run_uuid:=(p_input->>'runId')::uuid;
 END IF;
 IF p_action='start' THEN
  IF jsonb_typeof(p_input->'level') IS DISTINCT FROM 'number' OR coalesce(p_input->>'level','')!~'^(10|[1-9])$' THEN
   RETURN target_private.error_result(400,'INVALID_CHALLENGE_REQUEST','レベルを選んでください。'); END IF;
  chosen_level:=(p_input->>'level')::integer;
 END IF;
 IF p_action IN ('start','answer','pause','resume','abort') THEN
  IF coalesce(p_input->>'requestId','')!~'^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' THEN
   RETURN target_private.error_result(400,'INVALID_CHALLENGE_REQUEST','送信内容を確認してください。'); END IF;
  request_uuid:=(p_input->>'requestId')::uuid;
  request_hash:=encode(sha256(convert_to(jsonb_build_object('action',p_action,'input',p_input-'memberId'-'name'-'sessionHash')::text,'UTF8')),'hex');
 END IF;
 IF p_action='answer' THEN
  IF coalesce(p_input->>'questionId','')!~'^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
   coalesce(p_input->>'choiceId','')!~'^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' THEN
   RETURN target_private.error_result(400,'INVALID_CHALLENGE_REQUEST','回答内容を確認してください。'); END IF;
  q_uuid:=(p_input->>'questionId')::uuid;choice_uuid:=(p_input->>'choiceId')::uuid;
 END IF;
 -- Same lock/order as all shared-wallet writers. Serializes cross-session starts and rewards.
 PERFORM pg_advisory_xact_lock(991101);
 now_at:=clock_timestamp();minute_value:=floor(extract(epoch FROM now_at)/60)::bigint;
 INSERT INTO target_private.challenge_rates(member_id,minute_bucket,calls) VALUES(actor,minute_value,1)
 ON CONFLICT(member_id) DO UPDATE SET minute_bucket=minute_value,
 calls=CASE WHEN challenge_rates.minute_bucket=minute_value THEN least(601,challenge_rates.calls+1) ELSE 1 END
 RETURNING calls INTO call_count;
 IF call_count>600 THEN RETURN target_private.error_result(429,'CHALLENGE_RATE_LIMIT','操作が多いため、少し待ってください。'); END IF;
 UPDATE target_private.profiles SET name=btrim(p_input->>'name') WHERE member_id=actor AND name IS DISTINCT FROM btrim(p_input->>'name');
 IF p_action='map' THEN
  SELECT id INTO run_uuid FROM target_private.challenge_runs WHERE member_id=actor AND status IN ('playing','paused');
  IF run_uuid IS NOT NULL THEN PERFORM target_private.challenge_tick(run_uuid,now_at); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('level',b.level,'memberId',b.member_id,'name',profile.name) ORDER BY b.level,b.earned_at,b.member_id),'[]')
   INTO candidates FROM target_private.challenge_badges b JOIN target_private.profiles profile USING(member_id);
  RETURN jsonb_build_object('ok',true,'levels',(
   SELECT jsonb_agg(jsonb_build_object('level',l,'unlocked',l=1 OR EXISTS(SELECT 1 FROM target_private.challenge_badges b WHERE b.member_id=actor AND b.level=l-1),
    'cleared',EXISTS(SELECT 1 FROM target_private.challenge_badges b WHERE b.member_id=actor AND b.level=l),
    'enemyMaxHp',100*l,'playerMaxHp',100+50*(l-1),
    'attackIntervalMs',CASE WHEN l=10 THEN 1000 ELSE 2000-100*(l-1) END,
    'attackDamage',CASE WHEN l=10 THEN 15 ELSE 5+(l-1) END,'reward',l*100000,
    'badge',jsonb_build_object('id','challenge-level-'||l,'name','挑戦 Lv.'||l,'level',l)) ORDER BY l)
   FROM generate_series(1,10) l),'clearerCandidates',candidates,
   'activeRun',target_private.challenge_dto(run_uuid,actor),'wallet',target_private.games_wallet(actor));
 END IF;
 IF request_uuid IS NOT NULL THEN
  SELECT * INTO old_request FROM target_private.challenge_requests WHERE member_id=actor AND request_id=request_uuid;
  IF old_request.request_id IS NOT NULL THEN
   IF old_request.action<>p_action OR old_request.payload_hash<>request_hash THEN
    RETURN target_private.error_result(409,'CHALLENGE_REQUEST_CONFLICT','送信済みの内容が異なります。'); END IF;
   PERFORM target_private.challenge_tick(old_request.run_id,now_at);
   RETURN (old_request.response-'run'-'wallet')||jsonb_build_object('ok',true,'replayed',true,
    'run',target_private.challenge_dto(old_request.run_id,actor),'wallet',target_private.games_wallet(actor));
  END IF;
 END IF;
 IF p_action='start' THEN
  IF chosen_level>1 AND NOT EXISTS(SELECT 1 FROM target_private.challenge_badges WHERE member_id=actor AND level=chosen_level-1) THEN
   RETURN target_private.error_result(409,'CHALLENGE_LOCKED','前のレベルをクリアしてください。'); END IF;
  SELECT * INTO r FROM target_private.challenge_runs WHERE member_id=actor AND status IN ('playing','paused') FOR UPDATE;
  IF r.id IS NOT NULL THEN
   PERFORM target_private.challenge_tick(r.id,now_at);
   SELECT * INTO r FROM target_private.challenge_runs WHERE id=r.id;
   IF r.status IN ('playing','paused') THEN RETURN target_private.error_result(409,'CHALLENGE_ACTIVE_RUN','進行中の挑戦を再開または終了してください。'); END IF;
  END IF;
  pace:=CASE WHEN chosen_level=10 THEN 1000 ELSE 2000-100*(chosen_level-1) END;
  INSERT INTO target_private.challenge_runs(member_id,level,player_hp,enemy_hp,attack_remaining_ms)
   VALUES(actor,chosen_level,100+50*(chosen_level-1),100*chosen_level,pace) RETURNING * INTO r;
  run_uuid:=r.id;
 ELSE
  SELECT * INTO r FROM target_private.challenge_runs WHERE id=run_uuid AND member_id=actor FOR UPDATE;
  IF r.id IS NULL THEN RETURN target_private.error_result(404,'CHALLENGE_NOT_FOUND','挑戦が見つかりません。'); END IF;
  PERFORM target_private.challenge_tick(r.id,now_at);
  SELECT * INTO r FROM target_private.challenge_runs WHERE id=run_uuid;
  pace:=CASE WHEN r.level=10 THEN 1000 ELSE 2000-100*(r.level-1) END;
 END IF;
 IF p_action='pause' AND r.status='playing' THEN
  UPDATE target_private.challenge_runs SET status='paused',
   attack_remaining_ms=CASE WHEN next_attack_at IS NULL THEN attack_remaining_ms ELSE greatest(0,ceil(extract(epoch FROM (next_attack_at-now_at))*1000)::integer) END,
   next_attack_at=NULL,updated_at=now_at WHERE id=r.id;
 ELSIF p_action='resume' AND r.status='paused' THEN
  UPDATE target_private.challenge_runs SET status='playing',
   next_attack_at=CASE WHEN jsonb_array_length(questions)>0 THEN now_at+attack_remaining_ms*interval '1 millisecond' ELSE NULL END,
   updated_at=now_at WHERE id=r.id;
 ELSIF p_action='abort' AND r.status IN ('playing','paused') THEN
  UPDATE target_private.challenge_runs SET status='aborted',questions='[]',next_attack_at=NULL,updated_at=now_at WHERE id=r.id;
 ELSIF p_action='next' AND r.status='playing' AND jsonb_array_length(r.questions)=0 THEN
  IF jsonb_typeof(p_input->'questions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'questions')<>10 THEN
   RETURN target_private.error_result(400,'CHALLENGE_INVALID_QUESTION','出題内容を確認できませんでした。'); END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_input->'questions') q WHERE q->>'book'='target1900')<>5 OR
   (SELECT count(*) FROM jsonb_array_elements(p_input->'questions') q WHERE q->>'book'='target1000')<>3 OR
   (SELECT count(*) FROM jsonb_array_elements(p_input->'questions') q WHERE q->>'book'='kobun400')<>2 OR
   (SELECT count(DISTINCT q->>'id') FROM jsonb_array_elements(p_input->'questions') q)<>10 THEN
   RETURN target_private.error_result(400,'CHALLENGE_INVALID_QUESTION','出題内容を確認できませんでした。'); END IF;
  FOR candidate IN SELECT value FROM jsonb_array_elements(p_input->'questions') LOOP
   sections:=CASE candidate->>'book' WHEN 'target1900' THEN 19 WHEN 'target1000' THEN 10 WHEN 'kobun400' THEN 4 END;
   max_section:=1+(sections-1)*(r.level-1)/9;
   IF jsonb_typeof(candidate)<>'object' OR pg_column_size(candidate)>8192 OR
    coalesce(candidate->>'id','')!~'^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
    coalesce(candidate->>'correctChoiceId','')!~'^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
    length(coalesce(candidate->>'correctText','')) NOT BETWEEN 1 AND 2000 OR
    length(coalesce(candidate->>'prompt','')) NOT BETWEEN 1 AND 3000 OR
    coalesce(candidate->>'number','')!~'^[0-9]{1,4}$' OR
    jsonb_typeof(candidate->'choices') IS DISTINCT FROM 'array' OR jsonb_array_length(candidate->'choices')<>4 THEN
    RETURN target_private.error_result(400,'CHALLENGE_INVALID_QUESTION','出題内容を確認できませんでした。'); END IF;
   IF (candidate->>'number')::integer NOT BETWEEN 1 AND max_section*100 OR
    (SELECT count(*) FROM jsonb_array_elements(candidate->'choices') c WHERE
     coalesce(c->>'id','')~'^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' AND length(coalesce(c->>'text','')) BETWEEN 1 AND 3000)<>4 OR
    (SELECT count(DISTINCT c->>'id') FROM jsonb_array_elements(candidate->'choices') c)<>4 OR
    (SELECT count(DISTINCT lower(btrim(c->>'text'))) FROM jsonb_array_elements(candidate->'choices') c)<>4 OR
    (SELECT count(*) FROM jsonb_array_elements(candidate->'choices') c WHERE c->>'id'=candidate->>'correctChoiceId' AND c->>'text'=candidate->>'correctText')<>1 THEN
    RETURN target_private.error_result(400,'CHALLENGE_INVALID_QUESTION','選択肢を確認できませんでした。'); END IF;
  END LOOP;
  UPDATE target_private.challenge_runs SET questions=p_input->'questions',sequence=sequence+1,
   next_attack_at=now_at+attack_remaining_ms*interval '1 millisecond',updated_at=now_at WHERE id=r.id;
 ELSIF p_action='answer' THEN
  -- Enemy attacks due at receipt take priority; a delayed answer cannot revive a defeated player.
  IF r.status<>'playing' THEN
   IF r.status='lost' THEN RETURN jsonb_build_object('ok',true,'run',target_private.challenge_dto(r.id,actor),'wallet',target_private.games_wallet(actor)); END IF;
   RETURN target_private.error_result(409,'CHALLENGE_NOT_PLAYING','この挑戦は回答できません。'); END IF;
  question:=r.questions->0;
  IF question IS NULL OR question->>'id'<>q_uuid::text THEN
   RETURN target_private.error_result(409,'CHALLENGE_QUESTION_STALE','最新の問題に戻ってください。'); END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(question->'choices') c WHERE c->>'id'=choice_uuid::text) THEN
   RETURN target_private.error_result(400,'INVALID_CHALLENGE_REQUEST','選択肢を確認してください。'); END IF;
  accepted:=question->>'correctChoiceId'=choice_uuid::text;
  IF accepted THEN
   damage:=5;bonus:=(r.streak+1)%5=0;
   IF bonus THEN heal:=least(10,100+50*(r.level-1)-r.player_hp); END IF;
   r.enemy_hp:=greatest(0,r.enemy_hp-5);r.player_hp:=r.player_hp+heal;r.streak:=r.streak+1;r.correct_count:=r.correct_count+1;
  ELSE
   damage:=10;enemy_heal:=least(10,100*r.level-r.enemy_hp);
   r.player_hp:=greatest(0,r.player_hp-10);r.enemy_hp:=r.enemy_hp+enemy_heal;r.streak:=0;r.wrong_count:=r.wrong_count+1;
  END IF;
  r.questions:=r.questions-0;
  IF r.enemy_hp=0 THEN
   SELECT * INTO p FROM target_private.profiles WHERE member_id=actor FOR UPDATE;
   SELECT coalesce(sum(escrow),0) INTO pending_payout FROM (
    SELECT escrow FROM target_private.battle_matches WHERE status='playing' AND actor IN (host_id,guest_id)
    UNION ALL SELECT escrow FROM target_private.two_player_matches WHERE status='playing' AND actor IN (host_id,guest_id)
   ) funded;
   IF p.total_points>max_income-r.level*100000-pending_payout OR p.casino_net>max_income-r.level*100000-pending_payout OR
    p.wallet_revision>=max_income-(CASE WHEN pending_payout>0 THEN 1 ELSE 0 END) THEN
    RETURN target_private.error_result(507,'CHALLENGE_WALLET_LIMIT','所持金の上限に達しています。'); END IF;
   INSERT INTO target_private.challenge_reward_events(run_id,member_id,level,amount) VALUES(r.id,actor,r.level,r.level*100000);
   UPDATE target_private.profiles SET total_points=total_points+r.level*100000,
    casino_net=casino_net+r.level*100000,updated_at=now_at WHERE member_id=actor;
   INSERT INTO target_private.challenge_badges(member_id,level,run_id) VALUES(actor,r.level,r.id) ON CONFLICT(member_id,level) DO NOTHING;
   awarded:=FOUND;r.status:='won';r.reward:=r.level*100000;r.badge_awarded:=awarded;
  ELSIF r.player_hp=0 THEN r.status:='lost'; END IF;
  IF r.status<>'playing' THEN r.questions:='[]';r.next_attack_at:=NULL;
  ELSIF jsonb_array_length(r.questions)=0 THEN
   r.attack_remaining_ms:=greatest(0,ceil(extract(epoch FROM (r.next_attack_at-now_at))*1000)::integer);r.next_attack_at:=NULL;
  ELSE r.sequence:=r.sequence+1; END IF;
  UPDATE target_private.challenge_runs SET player_hp=r.player_hp,enemy_hp=r.enemy_hp,streak=r.streak,
   correct_count=r.correct_count,wrong_count=r.wrong_count,status=r.status,questions=r.questions,
   sequence=r.sequence,next_attack_at=r.next_attack_at,attack_remaining_ms=r.attack_remaining_ms,
   reward=r.reward,badge_awarded=r.badge_awarded,updated_at=now_at WHERE id=r.id;
  answer_data:=jsonb_build_object('correct',accepted,'damage',damage,'healedHp',heal,'enemyHealedHp',enemy_heal,'streakBonus',bonus);
 END IF;
 output:=jsonb_build_object('ok',true,'run',target_private.challenge_dto(run_uuid,actor),'wallet',target_private.games_wallet(actor));
 IF answer_data IS NOT NULL THEN output:=output||jsonb_build_object('answer',answer_data); END IF;
 IF awarded OR r.reward>0 THEN output:=output||jsonb_build_object('reward',r.reward,'badgeAwarded',r.badge_awarded); END IF;
 IF request_uuid IS NOT NULL THEN
  INSERT INTO target_private.challenge_requests(member_id,request_id,action,payload_hash,run_id,response)
   VALUES(actor,request_uuid,p_action,request_hash,run_uuid,output-'run'-'wallet');
 END IF;
 RETURN output;
EXCEPTION WHEN SQLSTATE '54000' THEN
 RETURN target_private.error_result(507,'CAPACITY_LIMIT','保存容量の上限に達しました。時間をおいてお試しください。');
END; $challenge$;
REVOKE ALL ON FUNCTION public.target_challenge_rpc(text,text,jsonb) FROM PUBLIC,service_role;
GRANT EXECUTE ON FUNCTION public.target_challenge_rpc(text,text,jsonb) TO anon,authenticated;
-- Preserve all reviewed study/frame/refund/restoration ledgers. Challenge rewards
-- are game income, represented in both the live cache and this rebuild projection.
DO $finance$
DECLARE definition text; source text; marker text;
BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc INTO definition,source
 FROM pg_proc p WHERE p.oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure;
 marker:='SELECT member_id,delta,created_at FROM target_private.two_player_wallet_events UNION ALL SELECT member_id,delta,created_at FROM target_private.battle_wallet_events) a';
 IF md5(source)<>'ec405e35a05100a8330f771107dd3000' OR
  (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 OR
  position('target_private.challenge_reward_events' IN definition)>0 THEN
  RAISE EXCEPTION 'Reviewed Target finance projection has changed; challenge migration not safe'; END IF;
 EXECUTE replace(definition,marker,
  'SELECT member_id,delta,created_at FROM target_private.two_player_wallet_events UNION ALL '||
  'SELECT member_id,delta,created_at FROM target_private.battle_wallet_events UNION ALL '||
  'SELECT member_id,amount AS delta,created_at FROM target_private.challenge_reward_events) a');
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
  <>'eafe8da70cbd3912d5310c083bdc303f' THEN
  RAISE EXCEPTION 'Unexpected Target challenge finance projection'; END IF;
END; $finance$;
COMMIT;
