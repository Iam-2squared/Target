-- Permanent, server-observed Section completion. Neither a later miss nor quiz
-- receipt cleanup removes an achievement. This migration never changes scores,
-- money, word streaks, reward suppression, gacha items or accepted receipts.
BEGIN;
SELECT pg_advisory_xact_lock(991101);
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.mastery_snapshot(uuid,text)'::regprocedure)
      IS DISTINCT FROM '1f394b5a2c1ded19f67e62863dd979fc' OR
     (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.record_word_mastery()'::regprocedure)
      IS DISTINCT FROM '80f9a2e4e1b336f3a896c29ccfe8cb2f' THEN
    RAISE EXCEPTION 'Mastery functions changed; review the Section achievement migration again';
  END IF;
END $guard$;

CREATE TABLE target_private.section_mastery_achievements (
  member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
  book text NOT NULL CHECK(book IN ('target1900','target1000','kobun400')),
  section integer NOT NULL CHECK(section BETWEEN 1 AND CASE book
    WHEN 'target1900' THEN 19 WHEN 'target1000' THEN 10 WHEN 'kobun400' THEN 4 ELSE 0 END),
  achieved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_from text NOT NULL CHECK(recorded_from IN ('current_mastery','answer')),
  PRIMARY KEY(member_id,book,section)
);
CREATE INDEX section_mastery_achievements_book_section_idx
  ON target_private.section_mastery_achievements(book,section,achieved_at,member_id);
ALTER TABLE target_private.section_mastery_achievements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE target_private.section_mastery_achievements FROM PUBLIC,anon,authenticated,service_role;

-- Existing current 100% is authoritative. Old answer timestamps are transaction
-- start times, points now include mutable non-study incomes/restorations, zero-
-- award corrects share point snapshots, and expired quiz details can be deleted.
-- They cannot safely establish a complete historical ordering. Do not guess at
-- past completion for a currently incomplete Section. The recorded timestamp of
-- this seed is the first server observation, not an invented historical date.
INSERT INTO target_private.section_mastery_achievements(member_id,book,section,recorded_from)
SELECT member_id,book,(word_number-1)/100+1,'current_mastery'
FROM target_private.word_mastery WHERE correct_streak=2
GROUP BY member_id,book,(word_number-1)/100+1 HAVING count(*)=100;
DO $quota$
DECLARE required_bytes bigint;
BEGIN
  SELECT count(*)*256 INTO required_bytes FROM target_private.section_mastery_achievements;
  IF NOT EXISTS(SELECT 1 FROM target_private.system_state WHERE singleton
      AND logical_bytes+required_bytes<=104857600) THEN
    RAISE EXCEPTION 'Section achievements would exceed the configured storage ceiling';
  END IF;
  UPDATE target_private.system_state SET logical_bytes=logical_bytes+required_bytes WHERE singleton;
END $quota$;

CREATE FUNCTION target_private.record_section_mastery_achievement()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE selected_book text; selected_word integer; selected_section integer;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  -- The pre-existing record_word_mastery trigger has already checked the choice
  -- against the canonical quiz and charged any new word row. This AFTER trigger
  -- sorts after it by name and sees the new streak, including zero-reward corrects.
  IF NEW.response->>'correct' IS DISTINCT FROM 'true' THEN RETURN NEW; END IF;
  SELECT q.book,(question->>'number')::integer INTO selected_book,selected_word
  FROM target_private.quizzes q CROSS JOIN LATERAL jsonb_array_elements(q.questions) question
  WHERE q.id=NEW.quiz_id AND q.member_id=NEW.member_id AND question->>'id'=NEW.question_id::text;
  IF selected_word IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Section achievement answer has no canonical word';
  END IF;
  selected_section:=(selected_word-1)/100+1;
  IF EXISTS(SELECT 1 FROM target_private.section_mastery_achievements
      WHERE member_id=NEW.member_id AND book=selected_book AND section=selected_section) THEN RETURN NEW; END IF;
  IF (SELECT count(*) FROM target_private.word_mastery WHERE member_id=NEW.member_id AND book=selected_book
      AND word_number BETWEEN (selected_section-1)*100+1 AND selected_section*100 AND correct_streak=2)<>100 THEN
    RETURN NEW;
  END IF;
  -- The outer answer RPC charges NEW.charged_bytes only after all AFTER INSERT
  -- triggers return. Reserve that pending charge as well as our permanent row;
  -- the word row's reservation was already charged by record_word_mastery.
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
CREATE TRIGGER target_section_mastery_achievement AFTER INSERT ON target_private.answers
  FOR EACH ROW EXECUTE FUNCTION target_private.record_section_mastery_achievement();

CREATE OR REPLACE FUNCTION target_private.mastery_snapshot(p_member uuid,p_book text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  WITH material AS (
    SELECT CASE p_book WHEN 'target1900' THEN 1900 WHEN 'target1000' THEN 1000 WHEN 'kobun400' THEN 400 ELSE 0 END AS total
  ), sections AS (
    SELECT n AS section,(n-1)*100+1 AS first_number,least(n*100,total) AS last_number
    FROM material CROSS JOIN LATERAL generate_series(1,(total+99)/100) n
  ), counts AS (
    SELECT (word_number-1)/100+1 AS section,count(*) FILTER(WHERE correct_streak=2)::integer AS mastered,
      count(*) FILTER(WHERE needs_review)::integer AS review_count
    FROM target_private.word_mastery WHERE member_id=p_member AND book=p_book GROUP BY (word_number-1)/100+1
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
COMMIT;
