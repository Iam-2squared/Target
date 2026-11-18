-- CLI-generated migration. Adds Crown, Improve and CNN to normal study only.
-- No existing score, money, quiz, word mastery or achievement row is rewritten.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock(991101);

DO $guard$
DECLARE expected record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
   ('public.target_rpc(text,text,jsonb)','74c34b2054b679a693bd8268b594de55'),
   ('target_private.mastery_snapshot(uuid,text)','8e22dd7258d31e37fb9e40be4c1ec5c9'),
   ('target_private.record_word_mastery()','80f9a2e4e1b336f3a896c29ccfe8cb2f'),
   ('target_private.record_section_mastery_achievement()','37b4c7ad66eced1be9773dc00e968a6a'),
   ('public.target_badge_rpc(text,text,jsonb)','f6c522b09c9d3577a45fc76bb714b032')
 ) AS pins(signature,hash)
 LOOP
   IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure)
       IS DISTINCT FROM expected.hash THEN
     RAISE EXCEPTION 'Study material function changed: %',expected.signature;
   END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
   ('target_private.quizzes','quizzes_book_check'),
   ('target_private.quizzes','quizzes_check4'),
   ('target_private.word_mastery','word_mastery_book_check'),
   ('target_private.word_mastery','word_mastery_check'),
   ('target_private.section_mastery_achievements','section_mastery_achievements_book_check'),
   ('target_private.section_mastery_achievements','section_mastery_achievements_check')
 ) AS pins(relation_name,constraint_name)
 LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_constraint
       WHERE conrelid=expected.relation_name::regclass AND conname=expected.constraint_name AND contype='c') THEN
     RAISE EXCEPTION 'Study material constraint changed: %.%',expected.relation_name,expected.constraint_name;
   END IF;
 END LOOP;
END $guard$;

CREATE FUNCTION target_private.study_book_size(p_book text)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT CASE p_book WHEN 'target1900' THEN 1900 WHEN 'target1000' THEN 1000 WHEN 'kobun400' THEN 400
   WHEN 'crown' THEN 32 WHEN 'improve' THEN 42 WHEN 'cnn' THEN 24 ELSE 0 END;
$$;
REVOKE ALL ON FUNCTION target_private.study_book_size(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION target_private.study_sections(p_book text)
RETURNS TABLE(section integer,first_number integer,last_number integer)
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT n,(n-1)*100+1,least(n*100,target_private.study_book_size(p_book))
 FROM generate_series(1,CASE p_book WHEN 'target1900' THEN 19 WHEN 'target1000' THEN 10
   WHEN 'kobun400' THEN 4 ELSE 0 END) n
 UNION ALL
 SELECT v.section,v.first_number,v.last_number FROM (VALUES
   ('crown'::text,6,1,17),('crown',7,18,32),
   ('improve',8,1,10),('improve',9,11,20),('improve',10,21,30),('improve',11,31,42),
   ('cnn',1,1,24)
 ) v(book,section,first_number,last_number) WHERE v.book=p_book;
$$;
REVOKE ALL ON FUNCTION target_private.study_sections(text) FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE target_private.quizzes DROP CONSTRAINT quizzes_book_check;
ALTER TABLE target_private.quizzes ADD CONSTRAINT quizzes_book_check
 CHECK(book IN ('target1900','target1000','kobun400','crown','improve','cnn'));
ALTER TABLE target_private.quizzes DROP CONSTRAINT quizzes_check4;
ALTER TABLE target_private.quizzes ADD CONSTRAINT quizzes_check4
 CHECK(to_number<=target_private.study_book_size(book));
ALTER TABLE target_private.word_mastery DROP CONSTRAINT word_mastery_book_check;
ALTER TABLE target_private.word_mastery ADD CONSTRAINT word_mastery_book_check
 CHECK(book IN ('target1900','target1000','kobun400','crown','improve','cnn'));
ALTER TABLE target_private.word_mastery DROP CONSTRAINT word_mastery_check;
ALTER TABLE target_private.word_mastery ADD CONSTRAINT word_mastery_check
 CHECK(word_number BETWEEN 1 AND target_private.study_book_size(book));
ALTER TABLE target_private.section_mastery_achievements DROP CONSTRAINT section_mastery_achievements_book_check;
ALTER TABLE target_private.section_mastery_achievements ADD CONSTRAINT section_mastery_achievements_book_check
 CHECK(book IN ('target1900','target1000','kobun400','crown','improve','cnn'));
ALTER TABLE target_private.section_mastery_achievements DROP CONSTRAINT section_mastery_achievements_check;
ALTER TABLE target_private.section_mastery_achievements ADD CONSTRAINT section_mastery_achievements_check CHECK(
 (book='target1900' AND section BETWEEN 1 AND 19) OR
 (book='target1000' AND section BETWEEN 1 AND 10) OR
 (book='kobun400' AND section BETWEEN 1 AND 4) OR
 (book='crown' AND section IN (6,7)) OR
 (book='improve' AND section BETWEEN 8 AND 11) OR
 (book='cnn' AND section=1));

-- Expand only the normal-study whitelist and word upper bound. Every reward,
-- reward-lock, receipt, bonus, rate, replay and quota branch stays byte-identical.
DO $rpc$
DECLARE definition text; marker text; replacement text;
BEGIN
 SELECT pg_get_functiondef('public.target_rpc(text,text,jsonb)'::regprocedure) INTO definition;
 marker:='coalesce(p_input->>''book'','''') NOT IN (''target1900'',''target1000'',''kobun400'')';
 replacement:='coalesce(p_input->>''book'','''') NOT IN (''target1900'',''target1000'',''kobun400'',''crown'',''improve'',''cnn'')';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>2 THEN
   RAISE EXCEPTION 'Normal study book validation changed';
 END IF;
 definition:=replace(definition,marker,replacement);
 marker:='CASE selected_book WHEN ''target1900'' THEN 1900 WHEN ''target1000'' THEN 1000 WHEN ''kobun400'' THEN 400 ELSE 0 END';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
   RAISE EXCEPTION 'Normal study word bound changed';
 END IF;
 EXECUTE replace(definition,marker,'target_private.study_book_size(selected_book)');
END $rpc$;

CREATE OR REPLACE FUNCTION target_private.mastery_snapshot(p_member uuid,p_book text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 WITH sections AS (
   SELECT * FROM target_private.study_sections(p_book)
 ), counts AS (
   SELECT s.section,count(w.word_number) FILTER(WHERE w.correct_streak=2)::integer AS mastered,
     count(w.word_number) FILTER(WHERE w.needs_review)::integer AS review_count
   FROM sections s LEFT JOIN target_private.word_mastery w
     ON w.member_id=p_member AND w.book=p_book AND w.word_number BETWEEN s.first_number AND s.last_number
   GROUP BY s.section
 ), achievers AS (
   SELECT a.section,jsonb_agg(jsonb_build_object('memberId',a.member_id,'name',p.name,
     'achievedAt',to_char(a.achieved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     ORDER BY a.achieved_at,a.member_id) AS members
   FROM target_private.section_mastery_achievements a JOIN target_private.profiles p USING(member_id)
   WHERE a.book=p_book GROUP BY a.section
 )
 SELECT jsonb_build_object('book',p_book,'sections',(SELECT jsonb_agg(jsonb_build_object(
     'section',s.section,'from',s.first_number,'to',s.last_number,'total',s.last_number-s.first_number+1,
     'mastered',coalesce(c.mastered,0),'percent',coalesce(c.mastered,0)*100/(s.last_number-s.first_number+1),
     'reviewCount',coalesce(c.review_count,0),'achievers',coalesce(a.members,'[]'::jsonb)) ORDER BY s.section)
   FROM sections s LEFT JOIN counts c USING(section) LEFT JOIN achievers a USING(section)),
   'reviewNumbers',(SELECT coalesce(jsonb_agg(word_number ORDER BY word_number),'[]'::jsonb)
     FROM target_private.word_mastery WHERE member_id=p_member AND book=p_book AND needs_review));
$$;
REVOKE ALL ON FUNCTION target_private.mastery_snapshot(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION target_private.record_section_mastery_achievement()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE selected_book text; selected_word integer; selected_section integer;
 selected_first integer; selected_last integer;
BEGIN
 PERFORM pg_advisory_xact_lock(991101);
 IF NEW.response->>'correct' IS DISTINCT FROM 'true' THEN RETURN NEW; END IF;
 SELECT q.book,(question->>'number')::integer INTO selected_book,selected_word
 FROM target_private.quizzes q CROSS JOIN LATERAL jsonb_array_elements(q.questions) question
 WHERE q.id=NEW.quiz_id AND q.member_id=NEW.member_id AND question->>'id'=NEW.question_id::text;
 IF selected_word IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Section achievement answer has no canonical word';
 END IF;
 SELECT section,first_number,last_number INTO selected_section,selected_first,selected_last
 FROM target_private.study_sections(selected_book) WHERE selected_word BETWEEN first_number AND last_number;
 IF selected_section IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Section achievement word has no canonical section';
 END IF;
 IF EXISTS(SELECT 1 FROM target_private.section_mastery_achievements
     WHERE member_id=NEW.member_id AND book=selected_book AND section=selected_section) THEN RETURN NEW; END IF;
 IF (SELECT count(*) FROM target_private.word_mastery WHERE member_id=NEW.member_id AND book=selected_book
     AND word_number BETWEEN selected_first AND selected_last AND correct_streak=2)<>selected_last-selected_first+1 THEN
   RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM target_private.system_state WHERE singleton
     AND logical_bytes+NEW.charged_bytes+256<=104857600) THEN
   RAISE EXCEPTION USING ERRCODE='P0750',MESSAGE='Section achievement storage ceiling reached';
 END IF;
 INSERT INTO target_private.section_mastery_achievements(member_id,book,section,recorded_from)
   VALUES(NEW.member_id,selected_book,selected_section,'answer');
 UPDATE target_private.system_state SET logical_bytes=logical_bytes+256 WHERE singleton;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION target_private.record_section_mastery_achievement() FROM PUBLIC,anon,authenticated,service_role;

-- The KGS badge bridge deliberately keeps its established 33-section/37-ID
-- catalog. New study achievements must not revoke an existing grand badge or
-- send unsupported artwork IDs to a different application's legacy consumer.
DO $badges$
DECLARE definition text; marker text;
BEGIN
 SELECT pg_get_functiondef('public.target_badge_rpc(text,text,jsonb)'::regprocedure) INTO definition;
 marker:='WHERE member_id=learner';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>2 THEN
   RAISE EXCEPTION 'Legacy badge achievement filtering changed';
 END IF;
 EXECUTE replace(definition,marker,
   'WHERE member_id=learner AND book IN (''target1900'',''target1000'',''kobun400'')');
END $badges$;

NOTIFY pgrst,'reload schema';
COMMIT;
