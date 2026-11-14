-- Independent rapid-answer Target battle. Preserve the existing shared-buzzer,
-- legacy, scoreboard, and financial tables/receipts without resetting records.
-- Server owns all answer grading, hit damage, streaks and healing.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);

DO $preflight$
BEGIN
 IF to_regclass('target_private.battle_matches') IS NULL OR
    to_regclass('target_private.battle_answers') IS NULL OR
    to_regclass('target_private.battle_current_questions') IS NULL OR
    to_regprocedure('public.target_buzzer_rpc(text,text,jsonb)') IS NULL OR
    EXISTS(SELECT 1 FROM target_private.battle_matches WHERE status='playing') THEN
    RAISE EXCEPTION 'Sprint migration requires the reviewed battle schema and zero active funded matches';
 END IF;
END; $preflight$;

ALTER TABLE target_private.battle_matches
  ADD COLUMN host_streak smallint NOT NULL DEFAULT 0 CHECK(host_streak BETWEEN 0 AND 4),
  ADD COLUMN guest_streak smallint NOT NULL DEFAULT 0 CHECK(guest_streak BETWEEN 0 AND 4);
ALTER TABLE target_private.battle_answers
  ADD COLUMN healed_hp smallint NOT NULL DEFAULT 0 CHECK(healed_hp BETWEEN 0 AND 10),
  ADD COLUMN streak_bonus boolean NOT NULL DEFAULT false,
  ADD COLUMN question_number smallint CHECK(question_number BETWEEN 1 AND 1900),
  ADD CONSTRAINT battle_answer_healing_proof CHECK(streak_bonus OR healed_hp=0);

-- Different players have separate questions; only their own correct answer
-- stays in private storage. The immutable answer ledger is the event feed.
CREATE FUNCTION target_private.battle_sprint_dto(p_match uuid,p_member uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $dto$
 SELECT jsonb_build_object(
   'id',m.id,'status',m.status,'book',m.book,'fromSection',m.from_section,'toSection',m.to_section,
   'stake',m.stake,'initialHp',m.initial_hp,'offerVersion',m.offer_version,
   'host',jsonb_build_object('id',m.host_id,'name',m.host_name,'ready',m.host_ready,
      'hp',m.host_hp,'streak',m.host_streak),
   'guest',jsonb_build_object('id',m.guest_id,'name',m.guest_name,'ready',m.guest_ready,
      'hp',m.guest_hp,'streak',m.guest_streak),
   'myRole',CASE WHEN p_member=m.host_id THEN 'host' ELSE 'guest' END,
   'pot',CASE WHEN m.status='playing' THEN m.escrow
     WHEN m.status IN ('invited','setup') THEN 2*m.stake ELSE 0 END,
   'winner',m.winner,'reason',m.reason,
   'createdAt',m.created_at,'updatedAt',m.updated_at,'expiresAt',m.expires_at,
   'question',CASE WHEN m.status='playing' THEN
      (SELECT q.question-'correctChoiceId'-'correctText'
       FROM target_private.battle_current_questions q
       WHERE q.match_id=m.id AND q.member_id=p_member) ELSE NULL END,
   'myLastNumber',(SELECT a.question_number FROM target_private.battle_answers a
     WHERE a.match_id=m.id AND a.member_id=p_member
     ORDER BY a.created_at DESC,a.request_id DESC LIMIT 1),
   'events',coalesce((
     SELECT jsonb_agg(jsonb_build_object(
       'id',a.request_id,
       'actorRole',CASE WHEN a.member_id=m.host_id THEN 'host' ELSE 'guest' END,
       'correct',a.correct,'damage',a.damage,
       'healedHp',a.healed_hp,'streakBonus',a.streak_bonus,'createdAt',a.created_at)
       ORDER BY a.created_at,a.request_id)
     FROM (
       SELECT * FROM target_private.battle_answers x
       WHERE x.match_id=m.id
       ORDER BY x.created_at DESC,x.request_id DESC LIMIT 15
     ) a), '[]'::jsonb))
 FROM target_private.battle_matches m
 WHERE m.id=p_match AND p_member IN (m.host_id,m.guest_id);
$dto$;
REVOKE ALL ON FUNCTION target_private.battle_sprint_dto(uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.target_sprint_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $sprint$
DECLARE
 actor uuid; match_uuid uuid; request_uuid uuid; q_uuid uuid; choice_uuid uuid;
 m target_private.battle_matches%rowtype;
 q target_private.battle_current_questions%rowtype;
 previous target_private.battle_requests%rowtype;
 candidate jsonb; request_hash text; payload jsonb;
 accepted boolean; actor_side text; old_streak int; new_streak int;
 healed int:=0; lost int; new_host_hp int; new_guest_hp int;
 new_host_streak int; new_guest_streak int; bonus boolean:=false;
 now_at timestamptz; keys text[]; key_count integer; answer_data jsonb; output jsonb;
BEGIN
 -- Check private backend secret before data parsing or lock acquisition.
 IF p_secret IS NULL OR length(p_secret) NOT BETWEEN 32 AND 256 OR NOT EXISTS(
   SELECT 1 FROM target_private.server_credentials
   WHERE singleton AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
   RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。');
 END IF;
 IF p_action IS NULL OR p_action NOT IN ('state','next','answer') OR
    p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR pg_column_size(p_input)>12000 THEN
   RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
 END IF;
 keys:=ARRAY['memberId','name','sessionHash','matchId'];
 IF p_action='next' THEN keys:=keys||ARRAY['question']; END IF;
 IF p_action='answer' THEN keys:=keys||ARRAY['requestId','questionId','choiceId']; END IF;
 SELECT count(*) INTO key_count FROM jsonb_object_keys(p_input);
 IF key_count<>array_length(keys,1) OR
    EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE NOT (k=ANY(keys))) OR
    coalesce(p_input->>'memberId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
    coalesce(p_input->>'matchId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
    coalesce(p_input->>'sessionHash','') !~ '^[0-9a-f]{64}$' OR
    jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR
    length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 20 THEN
   RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
 END IF;
 actor:=(p_input->>'memberId')::uuid;match_uuid:=(p_input->>'matchId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM target_private.profiles WHERE member_id=actor) THEN
   RETURN target_private.error_result(401,'BATTLE_LOGIN_REQUIRED','ログインし直してください。'); END IF;
 IF p_action='answer' THEN
   IF coalesce(p_input->>'requestId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
      coalesce(p_input->>'questionId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
      coalesce(p_input->>'choiceId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' THEN
     RETURN target_private.error_result(400,'INVALID_ANSWER','回答内容を確認してください。'); END IF;
   request_uuid:=(p_input->>'requestId')::uuid;
   q_uuid:=(p_input->>'questionId')::uuid;choice_uuid:=(p_input->>'choiceId')::uuid;
 END IF;
 IF p_action='state' THEN
   SELECT * INTO m FROM target_private.battle_matches WHERE id=match_uuid;
   IF m.id IS NULL OR actor NOT IN (m.host_id,m.guest_id) THEN
     RETURN target_private.error_result(404,'BATTLE_NOT_FOUND','対戦が見つかりません。'); END IF;
   RETURN jsonb_build_object('ok',true,'match',target_private.battle_sprint_dto(m.id,actor),
     'wallet',target_private.games_wallet(actor));
 END IF;
 PERFORM pg_advisory_xact_lock(991101);
 SELECT * INTO m FROM target_private.battle_matches WHERE id=match_uuid FOR UPDATE;
 IF m.id IS NULL OR actor NOT IN (m.host_id,m.guest_id) THEN
   RETURN target_private.error_result(404,'BATTLE_NOT_FOUND','対戦が見つかりません。'); END IF;
 actor_side:=CASE WHEN actor=m.host_id THEN 'host' ELSE 'guest' END;
 now_at:=clock_timestamp();
 IF p_action='answer' THEN
   request_hash:=encode(sha256(convert_to(
      jsonb_build_object('action','answer','input',p_input-'memberId'-'name'-'sessionHash')::text,
      'UTF8')),'hex');
   SELECT * INTO previous FROM target_private.battle_requests
     WHERE member_id=actor AND request_id=request_uuid;
   IF previous.request_id IS NOT NULL THEN
     IF previous.action<>'answer' OR previous.payload_hash<>request_hash THEN
       RETURN target_private.error_result(409,'BATTLE_REQUEST_CONFLICT','送信済みの回答内容が異なります。'); END IF;
     RETURN (previous.response-'match'-'wallet')||jsonb_build_object(
       'ok',true,'replayed',true,'match',target_private.battle_sprint_dto(previous.match_id,actor),
       'wallet',target_private.games_wallet(actor));
   END IF;
 END IF;
 IF m.status<>'playing' THEN
   IF p_action='next' THEN
     RETURN jsonb_build_object('ok',true,'match',target_private.battle_sprint_dto(m.id,actor),
       'wallet',target_private.games_wallet(actor)); END IF;
   RETURN target_private.error_result(409,'BATTLE_NOT_PLAYING','この試合は終了しています。');
 END IF;
 IF m.expires_at<=now_at THEN
   PERFORM target_private.battle_settle(m.id,NULL,'idle_timeout');
   RETURN jsonb_build_object('ok',true,'match',target_private.battle_sprint_dto(m.id,actor),
     'wallet',target_private.games_wallet(actor));
 END IF;
 IF p_action='next' THEN
   IF EXISTS(SELECT 1 FROM target_private.battle_current_questions
      WHERE match_id=m.id AND member_id=actor) THEN
     RETURN jsonb_build_object('ok',true,'match',target_private.battle_sprint_dto(m.id,actor),
       'wallet',target_private.games_wallet(actor));
   END IF;
   IF (CASE WHEN actor=m.host_id THEN m.host_sequence ELSE m.guest_sequence END)>=1000 THEN
     PERFORM target_private.battle_settle(m.id,NULL,'idle_timeout');
     RETURN jsonb_build_object('ok',true,'match',target_private.battle_sprint_dto(m.id,actor),
       'wallet',target_private.games_wallet(actor));
   END IF;
   candidate:=p_input->'question';
   IF jsonb_typeof(candidate) IS DISTINCT FROM 'object' OR pg_column_size(candidate)>8192 OR
      coalesce(candidate->>'id','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
      coalesce(candidate->>'correctChoiceId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' OR
      jsonb_typeof(candidate->'correctText') IS DISTINCT FROM 'string' OR
      length(candidate->>'correctText') NOT BETWEEN 1 AND 2000 OR
      length(coalesce(candidate->>'prompt','')) NOT BETWEEN 1 AND 3000 OR
      coalesce(candidate->>'number','') !~ '^[0-9]{1,4}$' OR
      jsonb_typeof(candidate->'choices') IS DISTINCT FROM 'array' OR
      jsonb_array_length(candidate->'choices')<>4 THEN
     RETURN target_private.error_result(400,'BATTLE_INVALID_QUESTION','出題内容を確認できませんでした。');
   END IF;
   IF (candidate->>'number')::integer NOT BETWEEN ((m.from_section-1)*100+1) AND m.to_section*100 OR
      (SELECT count(*) FROM jsonb_array_elements(candidate->'choices') c
       WHERE coalesce(c->>'id','') ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
       AND length(coalesce(c->>'text','')) BETWEEN 1 AND 3000)<>4 OR
      (SELECT count(DISTINCT c->>'id') FROM jsonb_array_elements(candidate->'choices') c)<>4 OR
      (SELECT count(DISTINCT lower(btrim(c->>'text'))) FROM jsonb_array_elements(candidate->'choices') c)<>4 OR
      (SELECT count(*) FROM jsonb_array_elements(candidate->'choices') c
         WHERE c->>'id'=candidate->>'correctChoiceId')<>1 THEN
     RETURN target_private.error_result(400,'BATTLE_INVALID_QUESTION','選択肢を確認できませんでした。');
   END IF;
   UPDATE target_private.battle_matches SET
      host_sequence=host_sequence+(CASE WHEN host_id=actor THEN 1 ELSE 0 END),
      guest_sequence=guest_sequence+(CASE WHEN guest_id=actor THEN 1 ELSE 0 END),
      updated_at=now_at,expires_at=now_at+interval '10 minutes'
   WHERE id=m.id RETURNING * INTO m;
   INSERT INTO target_private.battle_current_questions(match_id,member_id,sequence,question)
   VALUES(m.id,actor,
     CASE WHEN actor=m.host_id THEN m.host_sequence ELSE m.guest_sequence END,candidate);
   RETURN jsonb_build_object('ok',true,'match',target_private.battle_sprint_dto(m.id,actor),
     'wallet',target_private.games_wallet(actor));
 END IF;

 -- Answer exactly one participant-specific question. Arrival of a rival's
 -- answer cannot close or replace this question.
 SELECT * INTO q FROM target_private.battle_current_questions
   WHERE match_id=m.id AND member_id=actor FOR UPDATE;
 IF q.match_id IS NULL OR coalesce(q.question->>'id','')<>q_uuid::text THEN
   RETURN target_private.error_result(409,'BATTLE_QUESTION_CHANGED','次の問題を読み直してください。'); END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.question->'choices') c
   WHERE c->>'id'=choice_uuid::text) THEN
   RETURN target_private.error_result(400,'BATTLE_INVALID_CHOICE','選択肢を確認してください。'); END IF;
 accepted:=(q.question->>'correctChoiceId'=choice_uuid::text);
 old_streak:=CASE WHEN actor=m.host_id THEN m.host_streak ELSE m.guest_streak END;
 bonus:=accepted AND old_streak=4;
 new_streak:=CASE WHEN accepted THEN (old_streak+1)%5 ELSE 0 END;
 healed:=CASE WHEN bonus THEN
     LEAST(10,m.initial_hp-(CASE WHEN actor=m.host_id THEN m.host_hp ELSE m.guest_hp END))
     ELSE 0 END;
 lost:=CASE WHEN accepted THEN 5 ELSE 10 END;
 new_host_hp:=GREATEST(0,LEAST(m.initial_hp,m.host_hp+
     (CASE WHEN actor=m.host_id THEN
        (CASE WHEN accepted THEN healed ELSE -10 END)
       ELSE (CASE WHEN accepted THEN -5 ELSE 0 END) END)));
 new_guest_hp:=GREATEST(0,LEAST(m.initial_hp,m.guest_hp+
     (CASE WHEN actor=m.guest_id THEN
        (CASE WHEN accepted THEN healed ELSE -10 END)
       ELSE (CASE WHEN accepted THEN -5 ELSE 0 END) END)));
 new_host_streak:=CASE WHEN actor=m.host_id THEN new_streak ELSE m.host_streak END;
 new_guest_streak:=CASE WHEN actor=m.guest_id THEN new_streak ELSE m.guest_streak END;

 INSERT INTO target_private.battle_answers(match_id,member_id,question_id,sequence,
     request_id,choice_id,correct,damage,correct_text,healed_hp,streak_bonus,question_number)
 VALUES(m.id,actor,q_uuid,q.sequence,request_uuid,choice_uuid,accepted,lost,
     q.question->>'correctText',healed,bonus,(q.question->>'number')::smallint);
 DELETE FROM target_private.battle_current_questions WHERE match_id=m.id AND member_id=actor;
 UPDATE target_private.battle_matches SET
    host_hp=new_host_hp,guest_hp=new_guest_hp,
    host_streak=new_host_streak,guest_streak=new_guest_streak,
    updated_at=now_at,expires_at=now_at+interval '10 minutes'
 WHERE id=m.id;

 IF new_host_hp=0 OR new_guest_hp=0 THEN
   PERFORM target_private.battle_settle(m.id,CASE WHEN new_host_hp=0 THEN 'guest' ELSE 'host' END,'hp_zero');
 END IF;
 answer_data:=jsonb_build_object('correct',accepted,'damage',lost,
   'healedHp',healed,'streakBonus',bonus,'streak',new_streak,
   'questionId',q_uuid);
 output:=jsonb_build_object('ok',true,'answer',answer_data,
   'match',target_private.battle_sprint_dto(m.id,actor),
   'wallet',target_private.games_wallet(actor));
 INSERT INTO target_private.battle_requests(member_id,request_id,action,payload_hash,match_id,response)
 VALUES(actor,request_uuid,'answer',request_hash,m.id,output);
 RETURN output;
END; $sprint$;

REVOKE ALL ON FUNCTION public.target_sprint_rpc(text,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.target_sprint_rpc(text,text,jsonb) TO anon;
COMMENT ON FUNCTION public.target_sprint_rpc(text,text,jsonb) IS
 'KGS server-secret only independent Target quiz: correct opponent -5HP, wrong self -10HP, every 5 correct heal at most 10HP up to initial HP. Immutable answers and atomic wallet settlement.';
COMMIT;
