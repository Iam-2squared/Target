-- Target only. The public RPC has a separate, random server credential. Its
-- SHA-256 digest is provisioned privately after deployment; no secret lives here.
CREATE SCHEMA target_private;
REVOKE ALL ON SCHEMA target_private FROM PUBLIC,anon,authenticated;

CREATE TABLE target_private.server_credentials (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  key_hash text NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE target_private.profiles (
  member_id uuid PRIMARY KEY,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 20),
  correct_count bigint NOT NULL DEFAULT 0 CHECK(correct_count BETWEEN 0 AND 1000000000),
  answered_count bigint NOT NULL DEFAULT 0 CHECK(answered_count BETWEEN correct_count AND 1000000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE target_private.quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
  request_id uuid NOT NULL,
  book text NOT NULL CHECK(book IN ('target1900','target1000')),
  direction text NOT NULL CHECK(direction IN ('english','japanese')),
  from_number integer NOT NULL CHECK(from_number>=1),
  to_number integer NOT NULL CHECK(to_number>=from_number),
  questions jsonb NOT NULL CHECK(jsonb_typeof(questions)='array'),
  total integer NOT NULL CHECK(total BETWEEN 1 AND 20),
  answered_count integer NOT NULL DEFAULT 0 CHECK(answered_count BETWEEN 0 AND total),
  correct_count integer NOT NULL DEFAULT 0 CHECK(correct_count BETWEEN 0 AND answered_count),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',
  finished_at timestamptz,
  charged_bytes integer NOT NULL CHECK(charged_bytes>0),
  UNIQUE(member_id,request_id),
  CHECK(jsonb_array_length(questions)=total),
  CHECK(to_number<=CASE book WHEN 'target1900' THEN 1900 ELSE 1000 END)
);
CREATE TABLE target_private.answers (
  quiz_id uuid NOT NULL REFERENCES target_private.quizzes(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
  question_id uuid NOT NULL,
  choice_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_ids uuid[] NOT NULL CHECK(cardinality(request_ids) BETWEEN 1 AND 32),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  charged_bytes integer NOT NULL CHECK(charged_bytes>0),
  PRIMARY KEY(quiz_id,question_id),
  UNIQUE(member_id,request_id)
);
CREATE INDEX quizzes_expiry_idx ON target_private.quizzes(expires_at);
CREATE INDEX quizzes_member_created_idx ON target_private.quizzes(member_id,created_at DESC);
CREATE INDEX answers_member_created_idx ON target_private.answers(member_id,created_at DESC);
CREATE INDEX answers_request_ids_idx ON target_private.answers USING gin(request_ids);
CREATE TABLE target_private.rate_limits (
  identifier text NOT NULL CHECK(length(identifier) BETWEEN 1 AND 100),
  bucket bigint NOT NULL,
  attempt_count integer NOT NULL CHECK(attempt_count>0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(identifier,bucket)
);
CREATE INDEX rate_limits_expiry_idx ON target_private.rate_limits(expires_at);
CREATE TABLE target_private.system_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  quiz_count integer NOT NULL DEFAULT 0 CHECK(quiz_count>=0),
  answer_count integer NOT NULL DEFAULT 0 CHECK(answer_count>=0),
  logical_bytes bigint NOT NULL DEFAULT 0 CHECK(logical_bytes>=0)
);
INSERT INTO target_private.system_state(singleton) VALUES(true);

ALTER TABLE target_private.server_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.quizzes ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.system_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA target_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA target_private FROM PUBLIC,anon,authenticated;

CREATE FUNCTION target_private.error_result(p_status integer,p_code text,p_message text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('error',jsonb_build_object('status',p_status,'code',p_code,'message',p_message));
$$;
CREATE FUNCTION target_private.public_question(p_question jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_question IS NULL THEN NULL ELSE jsonb_build_object(
    'id',p_question->'id','prompt',p_question->'prompt',
    'number',p_question->'number','choices',p_question->'choices') END;
$$;
CREATE FUNCTION target_private.consume_rate(p_identifier text,p_period integer,p_limit integer)
RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,target_private AS $$
DECLARE
  ts double precision:=extract(epoch FROM clock_timestamp());
  current_bucket bigint;
  attempts integer;
BEGIN
  current_bucket:=floor(ts/p_period)::bigint;
  INSERT INTO target_private.rate_limits(identifier,bucket,attempt_count,expires_at)
    VALUES(p_identifier,current_bucket,1,to_timestamp((current_bucket+1)*p_period))
    ON CONFLICT(identifier,bucket) DO UPDATE SET attempt_count=least(target_private.rate_limits.attempt_count+1,p_limit+1)
    RETURNING attempt_count INTO attempts;
  IF attempts>p_limit THEN RETURN greatest(1,ceil((current_bucket+1)*p_period-ts)::integer); END IF;
  RETURN 0;
END $$;

CREATE FUNCTION public.target_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,target_private AS $$
DECLARE
  member_uuid uuid;
  quiz_uuid uuid;
  question_uuid uuid;
  choice_uuid uuid;
  request_uuid uuid;
  display_name text;
  selected_book text;
  selected_direction text;
  range_from integer;
  range_to integer;
  question_total integer;
  q target_private.quizzes%ROWTYPE;
  a target_private.answers%ROWTYPE;
  state target_private.system_state%ROWTYPE;
  questions_value jsonb;
  question_value jsonb;
  choice_value jsonb;
  response_value jsonb;
  correct_value boolean;
  next_answered integer;
  next_correct integer;
  new_bytes integer;
  wait_seconds integer;
  entry record;
BEGIN
  -- The credential gate runs before inspecting caller data or allocating rows.
  IF p_secret IS NULL OR length(p_secret)<32 OR length(p_secret)>256 OR
      NOT EXISTS(SELECT 1 FROM target_private.server_credentials WHERE singleton
        AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
    RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。');
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR pg_column_size(p_input)>262144 OR
      (p_action IS NULL OR p_action NOT IN ('rate','profile','start','answer','ranking')) THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
  END IF;
  IF p_action='ranking' THEN
    IF p_input<>'{}'::jsonb THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
    SELECT jsonb_build_object('ranking',coalesce(jsonb_agg(result_value ORDER BY row_rank),'[]'::jsonb),
      'updatedAt',clock_timestamp()) INTO response_value FROM (
      SELECT row_number() OVER(ORDER BY correct_count DESC,answered_count ASC,updated_at ASC,member_id ASC) AS row_rank,
        jsonb_build_object('rank',row_number() OVER(ORDER BY correct_count DESC,answered_count ASC,updated_at ASC,member_id ASC),
          'name',name,'correctCount',correct_count) AS result_value
      FROM target_private.profiles WHERE answered_count>0
      ORDER BY correct_count DESC,answered_count ASC,updated_at ASC,member_id ASC LIMIT 500
    ) ranked;
    RETURN response_value;
  END IF;

  -- Bounded shared writes use one transaction lock to keep quota checks,
  -- retries and all score increments atomic across independent clients.
  PERFORM pg_advisory_xact_lock(991101);
  DELETE FROM target_private.rate_limits WHERE expires_at<=clock_timestamp();
  IF p_action='rate' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>1 OR
      coalesce(p_input->>'identifier','')!~'^[a-f0-9]{64}$' THEN
      RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
    END IF;
    wait_seconds:=target_private.consume_rate('login:global',86400,3000);
    IF wait_seconds=0 THEN
      wait_seconds:=target_private.consume_rate('login:device:'||(p_input->>'identifier'),300,5);
    END IF;
    IF wait_seconds>0 THEN
      RETURN jsonb_set(target_private.error_result(429,'RATE_LIMITED','入力回数が多いため、時間をおいてお試しください。'),'{error,retryAfter}',to_jsonb(wait_seconds));
    END IF;
    RETURN jsonb_build_object('ok',true);
  END IF;

  IF coalesce(p_input->>'memberId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
      jsonb_typeof(p_input->'name')<>'string' OR length(btrim(coalesce(p_input->>'name','')))<1 OR length(btrim(p_input->>'name'))>20 THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
  END IF;
  member_uuid:=(p_input->>'memberId')::uuid;
  display_name:=btrim(p_input->>'name');
  IF NOT EXISTS(SELECT 1 FROM target_private.profiles WHERE member_id=member_uuid) AND
      (SELECT count(*) FROM target_private.profiles)>=500 THEN
    RETURN target_private.error_result(507,'CAPACITY_LIMIT','登録人数の上限に達しました。管理者へ連絡してください。');
  END IF;
  INSERT INTO target_private.profiles(member_id,name) VALUES(member_uuid,display_name)
    ON CONFLICT(member_id) DO UPDATE SET name=excluded.name,
      updated_at=CASE WHEN target_private.profiles.name IS DISTINCT FROM excluded.name THEN now() ELSE target_private.profiles.updated_at END;
  IF p_action='profile' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>2 THEN
      RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
    END IF;
    RETURN (SELECT jsonb_build_object('correctCount',correct_count) FROM target_private.profiles WHERE member_id=member_uuid);
  END IF;

  IF coalesce(p_input->>'requestId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
  END IF;
  request_uuid:=(p_input->>'requestId')::uuid;
  IF p_action='start' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>8 OR
        coalesce(p_input->>'book','') NOT IN ('target1900','target1000') OR
        coalesce(p_input->>'direction','') NOT IN ('english','japanese') OR
        jsonb_typeof(p_input->'from')<>'number' OR jsonb_typeof(p_input->'to')<>'number' OR
        coalesce(p_input->>'from','')!~'^[0-9]{1,4}$' OR coalesce(p_input->>'to','')!~'^[0-9]{1,4}$' OR
        jsonb_typeof(p_input->'questions')<>'array' THEN
      RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
    END IF;
    selected_book:=p_input->>'book'; selected_direction:=p_input->>'direction';
    range_from:=(p_input->>'from')::integer; range_to:=(p_input->>'to')::integer;
    questions_value:=p_input->'questions'; question_total:=jsonb_array_length(questions_value);
    IF question_total NOT BETWEEN 1 AND 20 OR range_from<1 OR range_to<range_from OR
        range_to>(CASE selected_book WHEN 'target1900' THEN 1900 ELSE 1000 END) OR
        range_to-range_from+1<question_total THEN
      RETURN target_private.error_result(400,'INVALID_RANGE','出題範囲を確認してください。');
    END IF;
    SELECT * INTO q FROM target_private.quizzes WHERE member_id=member_uuid AND request_id=request_uuid FOR UPDATE;
    IF FOUND THEN
      IF q.book<>selected_book OR q.direction<>selected_direction OR q.from_number<>range_from OR
          q.to_number<>range_to OR q.total<>question_total THEN
        RETURN target_private.error_result(409,'IDEMPOTENCY_CONFLICT','同じ開始操作の内容が異なります。');
      END IF;
      IF q.expires_at<=clock_timestamp() THEN RETURN target_private.error_result(409,'QUIZ_EXPIRED','テストの期限が切れました。新しいテストを始めてください。'); END IF;
      RETURN jsonb_build_object('quizId',q.id,'total',q.total,'answeredCount',q.answered_count,
        'correctCount',q.correct_count,'question',target_private.public_question(q.questions->q.answered_count));
    END IF;
    wait_seconds:=target_private.consume_rate('start:'||member_uuid::text,3600,120);
    IF wait_seconds>0 THEN RETURN jsonb_set(target_private.error_result(429,'RATE_LIMITED','しばらく待ってからテストを始めてください。'),'{error,retryAfter}',to_jsonb(wait_seconds)); END IF;
    -- Validate every stored question, including the four independently identified
    -- options. Answer keys remain private and never appear in the start DTO.
    FOR question_value IN SELECT value FROM jsonb_array_elements(questions_value) LOOP
      IF jsonb_typeof(question_value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(question_value))<>6 OR
          coalesce(question_value->>'id','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
          jsonb_typeof(question_value->'prompt')<>'string' OR length(coalesce(question_value->>'prompt','')) NOT BETWEEN 1 AND 2000 OR
          coalesce(question_value->>'number','')!~'^[0-9]{1,4}$' OR (question_value->>'number')::integer NOT BETWEEN range_from AND range_to OR
          jsonb_typeof(question_value->'choices')<>'array' OR jsonb_array_length(question_value->'choices')<>4 OR
          jsonb_typeof(question_value->'correctText')<>'string' OR length(coalesce(question_value->>'correctText','')) NOT BETWEEN 1 AND 2000 OR
          coalesce(question_value->>'correctChoiceId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
        RETURN target_private.error_result(400,'INVALID_QUESTIONS','出題内容を確認してください。');
      END IF;
      FOR choice_value IN SELECT value FROM jsonb_array_elements(question_value->'choices') LOOP
        IF jsonb_typeof(choice_value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(choice_value))<>2 OR
            coalesce(choice_value->>'id','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
            jsonb_typeof(choice_value->'text')<>'string' OR length(coalesce(choice_value->>'text','')) NOT BETWEEN 1 AND 2000 THEN
          RETURN target_private.error_result(400,'INVALID_QUESTIONS','出題内容を確認してください。');
        END IF;
      END LOOP;
      IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(question_value->'choices'))<>4 OR
          (SELECT count(DISTINCT value->>'text') FROM jsonb_array_elements(question_value->'choices'))<>4 OR
          NOT EXISTS(SELECT 1 FROM jsonb_array_elements(question_value->'choices') WHERE value->>'id'=question_value->>'correctChoiceId' AND value->>'text'=question_value->>'correctText') THEN
        RETURN target_private.error_result(400,'INVALID_QUESTIONS','出題内容を確認してください。');
      END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(questions_value))<>question_total OR
        (SELECT count(DISTINCT value->>'number') FROM jsonb_array_elements(questions_value))<>question_total THEN
      RETURN target_private.error_result(400,'INVALID_QUESTIONS','出題内容を確認してください。');
    END IF;
    -- Retain one week of expired quiz details. Lifetime totals are independent.
    FOR entry IN SELECT id,charged_bytes FROM target_private.quizzes WHERE expires_at<clock_timestamp()-interval '7 days' LIMIT 250 LOOP
      UPDATE target_private.system_state SET logical_bytes=logical_bytes-entry.charged_bytes-
          coalesce((SELECT sum(charged_bytes) FROM target_private.answers WHERE quiz_id=entry.id),0),
        answer_count=answer_count-(SELECT count(*) FROM target_private.answers WHERE quiz_id=entry.id),quiz_count=quiz_count-1 WHERE singleton;
      DELETE FROM target_private.quizzes WHERE id=entry.id;
    END LOOP;
    SELECT * INTO state FROM target_private.system_state WHERE singleton FOR UPDATE;
    new_bytes:=pg_column_size(questions_value)+512;
    IF state.quiz_count>=50000 OR state.logical_bytes+new_bytes>104857600 THEN
      RETURN target_private.error_result(507,'CAPACITY_LIMIT','保存容量の上限に達しました。時間をおいてお試しください。');
    END IF;
    INSERT INTO target_private.quizzes(member_id,request_id,book,direction,from_number,to_number,questions,total,charged_bytes)
      VALUES(member_uuid,request_uuid,selected_book,selected_direction,range_from,range_to,questions_value,question_total,new_bytes) RETURNING * INTO q;
    UPDATE target_private.system_state SET quiz_count=quiz_count+1,logical_bytes=logical_bytes+new_bytes WHERE singleton;
    RETURN jsonb_build_object('quizId',q.id,'total',q.total,'answeredCount',0,'correctCount',0,
      'question',target_private.public_question(q.questions->0));
  END IF;

  IF p_action='answer' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>6 OR
        coalesce(p_input->>'quizId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
        coalesce(p_input->>'questionId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
        coalesce(p_input->>'choiceId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
      RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
    END IF;
    quiz_uuid:=(p_input->>'quizId')::uuid; question_uuid:=(p_input->>'questionId')::uuid; choice_uuid:=(p_input->>'choiceId')::uuid;
    SELECT * INTO a FROM target_private.answers WHERE member_id=member_uuid AND request_ids @> ARRAY[request_uuid];
    IF FOUND THEN
      IF a.quiz_id<>quiz_uuid OR a.question_id<>question_uuid OR a.choice_id<>choice_uuid THEN
        RETURN target_private.error_result(409,'IDEMPOTENCY_CONFLICT','同じ解答操作の内容が異なります。');
      END IF;
      RETURN a.response;
    END IF;
    SELECT * INTO q FROM target_private.quizzes WHERE id=quiz_uuid AND member_id=member_uuid FOR UPDATE;
    IF NOT FOUND THEN RETURN target_private.error_result(404,'QUIZ_NOT_FOUND','テストが見つかりません。'); END IF;
    SELECT * INTO a FROM target_private.answers WHERE quiz_id=quiz_uuid AND question_id=question_uuid;
    IF FOUND THEN
      IF a.choice_id<>choice_uuid THEN RETURN target_private.error_result(409,'ANSWER_ALREADY_ACCEPTED','この問題は解答済みです。'); END IF;
      -- Bind an alternate retry ID too, so it cannot later identify a different
      -- payload. Aliases are bounded and never increment a score or rate reset.
      IF cardinality(a.request_ids)>=32 THEN RETURN target_private.error_result(429,'RETRY_LIMIT','再試行回数の上限に達しました。'); END IF;
      SELECT * INTO state FROM target_private.system_state WHERE singleton FOR UPDATE;
      IF state.logical_bytes+16>104857600 THEN RETURN target_private.error_result(507,'CAPACITY_LIMIT','保存容量の上限に達しました。'); END IF;
      UPDATE target_private.answers SET request_ids=array_append(request_ids,request_uuid),charged_bytes=charged_bytes+16
        WHERE quiz_id=quiz_uuid AND question_id=question_uuid;
      UPDATE target_private.system_state SET logical_bytes=logical_bytes+16 WHERE singleton;
      RETURN a.response;
    END IF;
    IF q.expires_at<=clock_timestamp() THEN RETURN target_private.error_result(409,'QUIZ_EXPIRED','テストの期限が切れました。新しいテストを始めてください。'); END IF;
    question_value:=q.questions->q.answered_count;
    IF question_value IS NULL OR question_value->>'id'<>question_uuid::text THEN
      RETURN target_private.error_result(409,'QUESTION_ORDER','表示中の問題から解答してください。');
    END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(question_value->'choices') WHERE value->>'id'=choice_uuid::text) THEN
      RETURN target_private.error_result(400,'INVALID_CHOICE','選択肢を確認してください。');
    END IF;
    wait_seconds:=target_private.consume_rate('answer:'||member_uuid::text,3600,1200);
    IF wait_seconds>0 THEN RETURN jsonb_set(target_private.error_result(429,'RATE_LIMITED','しばらく待ってから解答してください。'),'{error,retryAfter}',to_jsonb(wait_seconds)); END IF;
    correct_value:=question_value->>'correctChoiceId'=choice_uuid::text;
    next_answered:=q.answered_count+1; next_correct:=q.correct_count+CASE WHEN correct_value THEN 1 ELSE 0 END;
    response_value:=jsonb_build_object('correct',correct_value,'correctChoiceId',question_value->>'correctChoiceId',
      'correctText',question_value->>'correctText','answeredCount',next_answered,'correctCount',next_correct,'total',q.total,
      'finished',next_answered=q.total,'nextQuestion',target_private.public_question(q.questions->next_answered));
    SELECT * INTO state FROM target_private.system_state WHERE singleton FOR UPDATE;
    new_bytes:=pg_column_size(response_value)+256;
    IF state.answer_count>=200000 OR state.logical_bytes+new_bytes>104857600 OR
        (SELECT answered_count FROM target_private.profiles WHERE member_id=member_uuid)>=1000000000 THEN
      RETURN target_private.error_result(507,'CAPACITY_LIMIT','保存容量の上限に達しました。時間をおいてお試しください。');
    END IF;
    INSERT INTO target_private.answers(quiz_id,member_id,question_id,choice_id,request_id,request_ids,response,charged_bytes)
      VALUES(quiz_uuid,member_uuid,question_uuid,choice_uuid,request_uuid,ARRAY[request_uuid],response_value,new_bytes);
    UPDATE target_private.quizzes SET answered_count=next_answered,correct_count=next_correct,
      finished_at=CASE WHEN next_answered=total THEN now() ELSE NULL END WHERE id=quiz_uuid;
    UPDATE target_private.profiles SET answered_count=answered_count+1,
      correct_count=correct_count+CASE WHEN correct_value THEN 1 ELSE 0 END,updated_at=now() WHERE member_id=member_uuid;
    UPDATE target_private.system_state SET answer_count=answer_count+1,logical_bytes=logical_bytes+new_bytes WHERE singleton;
    RETURN response_value;
  END IF;
  RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR check_violation OR not_null_violation THEN
  RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA target_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.target_rpc(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.target_rpc(text,text,jsonb) TO anon;
COMMENT ON FUNCTION public.target_rpc(text,text,jsonb) IS 'Server-only Target RPC: a separate private credential is mandatory before every action.';
