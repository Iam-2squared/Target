-- Shared, server-authoritative buzzer round for both players.
-- No edits or resets to existing wallet, soccer, mastery, or settled HP battle receipts.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);

DO $gate$
BEGIN
  IF to_regclass('target_private.battle_matches') IS NULL OR
     to_regprocedure('public.target_battle_rpc(text,text,jsonb)') IS NULL OR
     EXISTS(SELECT 1 FROM target_private.battle_matches WHERE status='playing') THEN
    RAISE EXCEPTION 'Shared round transition requires existing schema and no funded active matches';
  END IF;
END $gate$;

CREATE TABLE target_private.battle_buzzer_rounds (
  match_id uuid NOT NULL REFERENCES target_private.battle_matches(id),
  round_no smallint NOT NULL CHECK(round_no BETWEEN 1 AND 160),
  question jsonb NOT NULL CHECK(jsonb_typeof(question)='object' AND pg_column_size(question)<=8192),
  starts_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  resolved_at timestamptz,
  next_at timestamptz,
  attacker text CHECK(attacker IN ('host','guest')),
  damage smallint NOT NULL DEFAULT 0 CHECK(damage IN (0,5)),
  PRIMARY KEY(match_id,round_no),
  CHECK(starts_at<deadline_at),
  CHECK((resolved_at IS NULL AND next_at IS NULL AND attacker IS NULL AND damage=0)
        OR (resolved_at IS NOT NULL AND next_at IS NOT NULL
            AND ((attacker IS NULL AND damage=0) OR (attacker IS NOT NULL AND damage=5))))
);
CREATE TABLE target_private.battle_buzzer_attempts (
  match_id uuid NOT NULL,
  round_no smallint NOT NULL,
  member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
  request_id uuid NOT NULL,
  question_id uuid NOT NULL,
  choice_id uuid NOT NULL,
  correct boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(match_id,round_no,member_id),
  UNIQUE(member_id,request_id),
  FOREIGN KEY(match_id,round_no) REFERENCES target_private.battle_buzzer_rounds(match_id,round_no)
);
CREATE INDEX battle_buzzer_attempts_member ON target_private.battle_buzzer_attempts(member_id,created_at DESC);

ALTER TABLE target_private.battle_buzzer_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.battle_buzzer_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE target_private.battle_buzzer_rounds,target_private.battle_buzzer_attempts
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION target_private.battle_buzzer_round_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
  IF OLD.resolved_at IS NOT NULL OR NEW.match_id IS DISTINCT FROM OLD.match_id OR
     NEW.round_no IS DISTINCT FROM OLD.round_no OR NEW.question IS DISTINCT FROM OLD.question OR
     NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR
     NEW.resolved_at IS NULL OR NEW.next_at IS NULL OR NEW.next_at<=NEW.resolved_at OR
     (NEW.attacker IS NULL AND NEW.damage<>0) OR (NEW.attacker IS NOT NULL AND NEW.damage<>5)
  THEN RAISE EXCEPTION 'Resolved buzzer round cannot be rewritten' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $guard$;
CREATE TRIGGER battle_buzzer_round_protect BEFORE UPDATE ON target_private.battle_buzzer_rounds
  FOR EACH ROW EXECUTE FUNCTION target_private.battle_buzzer_round_guard();
CREATE TRIGGER battle_buzzer_attempt_protect BEFORE UPDATE OR DELETE ON target_private.battle_buzzer_attempts
  FOR EACH ROW EXECUTE FUNCTION target_private.battle_immutable();

-- Shared public DTO: one persisted question ID and option ordering for both
-- players. The correct option ID/text stay strictly in the private table.
CREATE OR REPLACE FUNCTION target_private.battle_dto(p_match uuid,p_member uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $dto$
 SELECT jsonb_build_object(
  'id',m.id,'status',m.status,'book',m.book,'fromSection',m.from_section,'toSection',m.to_section,
  'stake',m.stake,'initialHp',m.initial_hp,'offerVersion',m.offer_version,
  'host',jsonb_build_object('id',m.host_id,'name',m.host_name,'ready',m.host_ready,'hp',m.host_hp),
  'guest',jsonb_build_object('id',m.guest_id,'name',m.guest_name,'ready',m.guest_ready,'hp',m.guest_hp),
  'myRole',CASE WHEN m.host_id=p_member THEN 'host' ELSE 'guest' END,
  'pot',CASE WHEN m.status='playing' THEN m.escrow WHEN m.status IN ('invited','setup') THEN 2*m.stake ELSE 0 END,
  'winner',m.winner,'reason',m.reason,'createdAt',m.created_at,'updatedAt',m.updated_at,'expiresAt',m.expires_at,
  'question',CASE WHEN m.status='playing' AND r.match_id IS NOT NULL
    THEN r.question-'correctChoiceId'-'correctText' ELSE NULL END,
  'round',coalesce(r.round_no,0),
  'roundPhase',CASE WHEN m.status<>'playing' THEN 'inactive'
     WHEN r.match_id IS NULL THEN 'waiting'
     WHEN r.resolved_at IS NOT NULL THEN 'cooldown'
     WHEN clock_timestamp()<r.starts_at THEN 'countdown'
     WHEN clock_timestamp()>=r.deadline_at THEN 'timeout'
     ELSE 'open' END,
  'startsAt',r.starts_at,'deadlineAt',r.deadline_at,'nextAt',r.next_at,
  'answered',CASE WHEN r.match_id IS NULL THEN false ELSE EXISTS(
    SELECT 1 FROM target_private.battle_buzzer_attempts a
    WHERE a.match_id=r.match_id AND a.round_no=r.round_no AND a.member_id=p_member) END,
  'roundResult',CASE WHEN r.resolved_at IS NULL THEN NULL ELSE jsonb_build_object(
    'round',r.round_no,'attacker',r.attacker,'damage',r.damage,
    'resolvedAt',r.resolved_at,'nextAt',r.next_at) END)
 FROM target_private.battle_matches m
 LEFT JOIN LATERAL (
   SELECT * FROM target_private.battle_buzzer_rounds x
   WHERE x.match_id=m.id ORDER BY round_no DESC LIMIT 1
 ) r ON true
 WHERE m.id=p_match AND p_member IN (m.host_id,m.guest_id);
$dto$;

-- Block stale V1 per-player question writes. All regular lobby, consent and
-- financial operations remain in their previously reviewed RPC.
DO $old_rpc$
DECLARE source text; marker text; replacement text;
BEGIN
 SELECT pg_get_functiondef('public.target_battle_rpc(text,text,jsonb)'::regprocedure) INTO source;
 marker:='IF p_action=''next'' THEN';
 IF (length(source)-length(replace(source,marker,'')))/length(marker)<>1 OR
    position('BATTLE_SHARED_ROUNDS_ONLY' IN source)>0 THEN
   RAISE EXCEPTION 'Legacy battle RPC action boundary changed; unsafe to upgrade'; END IF;
 replacement:='IF p_action IN (''next'',''answer'') THEN '||
   'RETURN target_private.error_result(410,''BATTLE_SHARED_ROUNDS_ONLY'',''古い対戦画面を更新してください。''); END IF;'||
   chr(10)||' IF p_action=''next'' THEN';
 EXECUTE replace(source,marker,replacement);
END; $old_rpc$;

-- All authoritative state transitions are serialized with the same global
-- ledger lock used by ordinary Target and 2player soccer.
CREATE FUNCTION public.target_buzzer_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $buzzer$
DECLARE
 actor uuid; match_uuid uuid; request_uuid uuid; question_uuid uuid; choice_uuid uuid;
 m target_private.battle_matches%rowtype; r target_private.battle_buzzer_rounds%rowtype;
 previous target_private.battle_requests%rowtype; payload_hash text; chosen jsonb;
 member_side text; was_correct boolean; damage_value integer:=0;
 new_host_hp integer; new_guest_hp integer; answer_data jsonb;
 allowed text[]; actual_keys integer; now_at timestamptz; match_json jsonb;
BEGIN
 -- The Target server-only key is verified BEFORE interpreting client data,
 -- acquiring locks, creating records, or charging any 轟.
 IF p_secret IS NULL OR length(p_secret) NOT BETWEEN 32 AND 256 OR NOT EXISTS(
   SELECT 1 FROM target_private.server_credentials WHERE singleton
    AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
   RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。'); END IF;
 IF p_action IS NULL OR p_action NOT IN ('state','next','answer') OR
    p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR pg_column_size(p_input)>12000 THEN
   RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
 allowed:=ARRAY['memberId','name','sessionHash','matchId'];
 IF p_action='next' THEN allowed:=allowed||'question'; END IF;
 IF p_action='answer' THEN allowed:=allowed||ARRAY['requestId','questionId','choiceId']; END IF;
 SELECT count(*) INTO actual_keys FROM jsonb_object_keys(p_input);
 IF actual_keys<>array_length(allowed,1) OR
    EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) key WHERE NOT(key=ANY(allowed))) OR
    coalesce(p_input->>'memberId','') !~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' OR
    coalesce(p_input->>'matchId','') !~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' OR
    coalesce(p_input->>'sessionHash','') !~ '^[a-f0-9]{64}$' OR
    jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR
    length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 20 THEN
   RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
 actor:=(p_input->>'memberId')::uuid;match_uuid:=(p_input->>'matchId')::uuid;
 IF p_action='answer' THEN
   IF coalesce(p_input->>'requestId','') !~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' OR
      coalesce(p_input->>'questionId','') !~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' OR
      coalesce(p_input->>'choiceId','') !~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' THEN
     RETURN target_private.error_result(400,'INVALID_ANSWER','回答を確認してください。'); END IF;
   request_uuid:=(p_input->>'requestId')::uuid;
   question_uuid:=(p_input->>'questionId')::uuid;choice_uuid:=(p_input->>'choiceId')::uuid;
 END IF;
 IF p_action='state' THEN
   SELECT * INTO m FROM target_private.battle_matches WHERE id=match_uuid;
   IF m.id IS NULL OR actor NOT IN (m.host_id,m.guest_id) THEN
     RETURN target_private.error_result(404,'BATTLE_NOT_FOUND','対戦が見つかりません。'); END IF;
   RETURN jsonb_build_object('ok',true,'match',target_private.battle_dto(m.id,actor),
     'wallet',target_private.games_wallet(actor)); END IF;

 PERFORM pg_advisory_xact_lock(991101);
 SELECT * INTO m FROM target_private.battle_matches WHERE id=match_uuid FOR UPDATE;
 IF m.id IS NULL OR actor NOT IN (m.host_id,m.guest_id) THEN
   RETURN target_private.error_result(404,'BATTLE_NOT_FOUND','対戦が見つかりません。'); END IF;
 member_side:=CASE WHEN actor=m.host_id THEN 'host' ELSE 'guest' END;
 now_at:=clock_timestamp();

 IF p_action='answer' THEN
   payload_hash:=encode(sha256(convert_to(
     jsonb_build_object('action','answer','input',p_input-'memberId'-'name'-'sessionHash')::text,'UTF8')),'hex');
   SELECT * INTO previous FROM target_private.battle_requests
     WHERE member_id=actor AND request_id=request_uuid;
   IF previous.request_id IS NOT NULL THEN
     IF previous.action<>'answer' OR previous.payload_hash<>payload_hash THEN
       RETURN target_private.error_result(409,'BATTLE_REQUEST_CONFLICT','同一送信IDの内容が変更されています。'); END IF;
     RETURN (previous.response-'match'-'wallet')||jsonb_build_object(
       'replayed',true,'match',target_private.battle_dto(previous.match_id,actor),
       'wallet',target_private.games_wallet(actor)); END IF;
 END IF;
 IF m.status<>'playing' THEN
   RETURN target_private.error_result(409,'BATTLE_NOT_PLAYING','この試合は終了しています。'); END IF;
 IF m.expires_at<=now_at THEN
   PERFORM target_private.battle_settle(m.id,NULL,'idle_timeout');
   RETURN jsonb_build_object('ok',true,'match',target_private.battle_dto(m.id,actor),
     'wallet',target_private.games_wallet(actor)); END IF;
 SELECT * INTO r FROM target_private.battle_buzzer_rounds
   WHERE match_id=m.id ORDER BY round_no DESC LIMIT 1 FOR UPDATE;

 IF p_action='next' THEN
   IF r.match_id IS NOT NULL AND r.resolved_at IS NULL AND r.deadline_at<=now_at THEN
     UPDATE target_private.battle_buzzer_rounds
       SET resolved_at=now_at,next_at=now_at+interval '1900 milliseconds'
       WHERE match_id=r.match_id AND round_no=r.round_no;
     RETURN jsonb_build_object('ok',true,'match',target_private.battle_dto(m.id,actor),
       'wallet',target_private.games_wallet(actor)); END IF;
   IF r.match_id IS NOT NULL AND
      (r.resolved_at IS NULL OR r.next_at>now_at) THEN
     RETURN jsonb_build_object('ok',true,'match',target_private.battle_dto(m.id,actor),
       'wallet',target_private.games_wallet(actor)); END IF;
   IF r.match_id IS NOT NULL AND r.round_no>=160 THEN
     PERFORM target_private.battle_settle(m.id,NULL,'idle_timeout');
     RETURN jsonb_build_object('ok',true,'match',target_private.battle_dto(m.id,actor),
       'wallet',target_private.games_wallet(actor)); END IF;
   chosen:=p_input->'question';
   IF jsonb_typeof(chosen) IS DISTINCT FROM 'object' OR pg_column_size(chosen)>8192 OR
      coalesce(chosen->>'id','') !~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' OR
      coalesce(chosen->>'correctChoiceId','') !~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' OR
      jsonb_typeof(chosen->'correctText') IS DISTINCT FROM 'string' OR
      length(chosen->>'correctText') NOT BETWEEN 1 AND 2000 OR
      length(coalesce(chosen->>'prompt','')) NOT BETWEEN 1 AND 3000 OR
      coalesce(chosen->>'number','') !~ '^[0-9]{1,4}$' OR
      jsonb_typeof(chosen->'choices') IS DISTINCT FROM 'array' OR
      jsonb_array_length(chosen->'choices')<>4 THEN
     RETURN target_private.error_result(400,'BATTLE_INVALID_QUESTION','出題を作成できませんでした。'); END IF;
   IF (chosen->>'number')::integer NOT BETWEEN ((m.from_section-1)*100+1) AND m.to_section*100 OR
      (SELECT count(*) FROM jsonb_array_elements(chosen->'choices') c
       WHERE coalesce(c->>'id','') ~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$'
         AND length(coalesce(c->>'text','')) BETWEEN 1 AND 3000)<>4 OR
      (SELECT count(DISTINCT c->>'id') FROM jsonb_array_elements(chosen->'choices') c)<>4 OR
      (SELECT count(DISTINCT lower(btrim(c->>'text'))) FROM jsonb_array_elements(chosen->'choices') c)<>4 OR
      (SELECT count(*) FROM jsonb_array_elements(chosen->'choices') c
       WHERE c->>'id'=chosen->>'correctChoiceId')<>1 THEN
     RETURN target_private.error_result(400,'BATTLE_INVALID_QUESTION','選択肢を確認できませんでした。'); END IF;
   IF r.match_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM target_private.battle_buzzer_rounds old
      WHERE old.match_id=m.id AND old.question->>'id'=chosen->>'id') THEN
     RETURN target_private.error_result(409,'BATTLE_DUPLICATE_QUESTION','問題を作り直してください。'); END IF;
   INSERT INTO target_private.battle_buzzer_rounds(match_id,round_no,question,starts_at,deadline_at)
     VALUES(m.id,coalesce(r.round_no,0)+1,chosen,
       now_at+interval '1600 milliseconds',now_at+interval '19600 milliseconds');
   UPDATE target_private.battle_matches SET expires_at=now_at+interval '10 minutes',
     updated_at=now_at WHERE id=m.id;
   RETURN jsonb_build_object('ok',true,'match',target_private.battle_dto(m.id,actor),
     'wallet',target_private.games_wallet(actor)); END IF;

 -- One attempt per player and shared round; PostgreSQL arrival order wins,
 -- never the browser-supplied clock, claimed score, choice key, or HP value.
 IF r.match_id IS NULL OR r.resolved_at IS NOT NULL THEN
   RETURN target_private.error_result(409,'BATTLE_ROUND_CLOSED','次の問題をお待ちください。'); END IF;
 IF r.deadline_at<=now_at THEN
   UPDATE target_private.battle_buzzer_rounds
     SET resolved_at=now_at,next_at=now_at+interval '1900 milliseconds'
     WHERE match_id=r.match_id AND round_no=r.round_no;
   RETURN target_private.error_result(409,'BATTLE_ROUND_CLOSED','次の問題をお待ちください。'); END IF;
 IF r.starts_at>now_at THEN
   RETURN target_private.error_result(409,'BATTLE_ROUND_NOT_STARTED','開始の合図をお待ちください。'); END IF;
 IF r.question->>'id'<>question_uuid::text THEN
   RETURN target_private.error_result(409,'BATTLE_QUESTION_CHANGED','問題が更新されました。'); END IF;
 IF EXISTS(SELECT 1 FROM target_private.battle_buzzer_attempts
   WHERE match_id=m.id AND round_no=r.round_no AND member_id=actor) THEN
   RETURN target_private.error_result(409,'BATTLE_ALREADY_ANSWERED','この問題には回答済みです。'); END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.question->'choices') c WHERE c->>'id'=choice_uuid::text) THEN
   RETURN target_private.error_result(400,'BATTLE_INVALID_CHOICE','選択肢を確認してください。'); END IF;
 was_correct:=(r.question->>'correctChoiceId'=choice_uuid::text);
 INSERT INTO target_private.battle_buzzer_attempts(match_id,round_no,member_id,request_id,question_id,choice_id,correct)
 VALUES(m.id,r.round_no,actor,request_uuid,question_uuid,choice_uuid,was_correct);

 IF was_correct THEN
   damage_value:=5;
   new_host_hp:=greatest(0,m.host_hp-CASE WHEN member_side='guest' THEN 5 ELSE 0 END);
   new_guest_hp:=greatest(0,m.guest_hp-CASE WHEN member_side='host' THEN 5 ELSE 0 END);
   UPDATE target_private.battle_matches
     SET host_hp=new_host_hp,guest_hp=new_guest_hp,updated_at=now_at,
       expires_at=now_at+interval '10 minutes' WHERE id=m.id;
   UPDATE target_private.battle_buzzer_rounds
     SET attacker=member_side,damage=5,resolved_at=now_at,
       next_at=now_at+interval '1900 milliseconds'
     WHERE match_id=m.id AND round_no=r.round_no;
   IF new_host_hp=0 OR new_guest_hp=0 THEN
     PERFORM target_private.battle_settle(m.id,CASE WHEN new_host_hp=0 THEN 'guest' ELSE 'host' END,'hp_zero'); END IF;
 ELSE
   -- A wrong buzz uses the player's only answer but does NOT damage either HP.
   -- If both players miss, advance with no winner after the same brief feedback.
   IF (SELECT count(*) FROM target_private.battle_buzzer_attempts
       WHERE match_id=m.id AND round_no=r.round_no)>=2 THEN
     UPDATE target_private.battle_buzzer_rounds
       SET resolved_at=now_at,next_at=now_at+interval '1900 milliseconds'
       WHERE match_id=m.id AND round_no=r.round_no;
   END IF;
 END IF;
 answer_data:=jsonb_build_object('correct',was_correct,'damage',damage_value,
   'questionId',question_uuid,'round',r.round_no);
 match_json:=target_private.battle_dto(m.id,actor);
 INSERT INTO target_private.battle_requests(member_id,request_id,action,payload_hash,match_id,response)
   VALUES(actor,request_uuid,'answer',payload_hash,m.id,
     jsonb_build_object('ok',true,'answer',answer_data,'match',match_json,'wallet',target_private.games_wallet(actor)));
 RETURN jsonb_build_object('ok',true,'answer',answer_data,'match',match_json,
   'wallet',target_private.games_wallet(actor));
END; $buzzer$;
REVOKE ALL ON FUNCTION public.target_buzzer_rpc(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.target_buzzer_rpc(text,text,jsonb) TO anon;
COMMENT ON FUNCTION public.target_buzzer_rpc(text,text,jsonb) IS
  'Server-only shared Target buzzer. One canonical question, first correct server-arrival wins 5 HP, wrong 0 HP, replay-safe.';
COMMIT;
