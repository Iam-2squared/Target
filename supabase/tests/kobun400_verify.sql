-- Synthetic fixtures and metadata only. Does not read credentials, real users,
-- real answers or conversations. Every row and quota effect is rolled back.
BEGIN;
SELECT pg_advisory_xact_lock(991101);
DO $verify$
DECLARE
  fixture uuid:=gen_random_uuid(); quiz_uuid uuid:=gen_random_uuid();
  choice_uuid uuid:=gen_random_uuid(); question_uuid uuid:=gen_random_uuid();
  value jsonb; question jsonb; material_book text; expected_sections integer;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '3a9cb9c8e0431e8e742509d8c608e1cf' OR
     (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.mastery_snapshot(uuid,text)'::regprocedure)
      IS DISTINCT FROM '1f394b5a2c1ded19f67e62863dd979fc' OR
     (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.record_word_mastery()'::regprocedure)
      IS DISTINCT FROM '80f9a2e4e1b336f3a896c29ccfe8cb2f' THEN
    RAISE EXCEPTION 'Unexpected textbook function hashes';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('target_private.quizzes'::regclass,'target_private.word_mastery'::regclass) AND NOT relrowsecurity) OR
     EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') AND
       (has_schema_privilege(rolname,'target_private','USAGE') OR
        has_table_privilege(rolname,'target_private.word_mastery','SELECT') OR
        has_table_privilege(rolname,'target_private.quizzes','INSERT') OR
        has_function_privilege(rolname,'target_private.mastery_snapshot(uuid,text)','EXECUTE'))) THEN
    RAISE EXCEPTION 'Unexpected textbook private permissions';
  END IF;
  INSERT INTO target_private.profiles(member_id,name) VALUES(fixture,'古語検証専用');
  FOREACH material_book IN ARRAY ARRAY['target1900','target1000','kobun400'] LOOP
    expected_sections:=CASE material_book WHEN 'target1900' THEN 19 WHEN 'target1000' THEN 10 ELSE 4 END;
    value:=target_private.mastery_snapshot(fixture,material_book);
    IF jsonb_array_length(value->'sections')<>expected_sections OR value->'reviewNumbers'<>'[]'::jsonb OR
        (value->'sections'->(expected_sections-1)->>'to')::integer<>expected_sections*100 THEN
      RAISE EXCEPTION 'Unexpected textbook section boundaries';
    END IF;
  END LOOP;
  INSERT INTO target_private.word_mastery(member_id,book,word_number,correct_streak,needs_review)
    VALUES(fixture,'kobun400',400,1,true);
  value:=target_private.mastery_snapshot(fixture,'kobun400');
  IF value->'reviewNumbers'<>'[400]'::jsonb OR value->'sections'->3->'percent'<>'0'::jsonb OR
      value->'sections'->3->'reviewCount'<>'1'::jsonb THEN
    RAISE EXCEPTION 'A single correct after a miss must remain in review';
  END IF;
  UPDATE target_private.word_mastery SET correct_streak=2,needs_review=false WHERE member_id=fixture AND book='kobun400' AND word_number=400;
  value:=target_private.mastery_snapshot(fixture,'kobun400');
  IF value->'reviewNumbers'<>'[]'::jsonb OR value->'sections'->3->'percent'<>'1'::jsonb THEN
    RAISE EXCEPTION 'Two correct answers must master one of100 section words';
  END IF;
  BEGIN
    INSERT INTO target_private.word_mastery(member_id,book,word_number,correct_streak,needs_review)
      VALUES(fixture,'kobun400',401,0,true);
    RAISE EXCEPTION 'A word outside the textbook was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  question:=jsonb_build_object('id',question_uuid,'prompt','検証用古語','number',400,
    'choices',jsonb_build_array(jsonb_build_object('id',choice_uuid,'text','検証用訳'),
      jsonb_build_object('id',gen_random_uuid(),'text','検証用選択肢A'),
      jsonb_build_object('id',gen_random_uuid(),'text','検証用選択肢B'),
      jsonb_build_object('id',gen_random_uuid(),'text','検証用選択肢C')),
    'correctChoiceId',choice_uuid,'correctText','検証用訳');
  INSERT INTO target_private.quizzes(id,member_id,request_id,book,direction,from_number,to_number,questions,total,charged_bytes)
    VALUES(quiz_uuid,fixture,gen_random_uuid(),'kobun400','japanese',400,400,jsonb_build_array(question),1,1024);
  BEGIN
    UPDATE target_private.quizzes SET to_number=401 WHERE id=quiz_uuid;
    RAISE EXCEPTION 'A quiz outside the textbook was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $verify$;
SELECT 'kobun400 private schema, exact boundaries, denominators and mastery states passed' AS verification;
ROLLBACK;
