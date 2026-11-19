-- Generated with supabase@3.0.0 migration new target_kobun_four_hundred.
-- Adds a third textbook without rewriting existing quizzes, learning or money.
SELECT pg_advisory_xact_lock(991101);
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure)
       IS DISTINCT FROM '2a07eca33e23209e5c9a849ce2f6a507' OR
     (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.mastery_snapshot(uuid,text)'::regprocedure)
       IS DISTINCT FROM '1b5e5a1efe24e9ab00907f8407cbfce0' OR
     (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.record_word_mastery()'::regprocedure)
       IS DISTINCT FROM '80f9a2e4e1b336f3a896c29ccfe8cb2f' THEN
    RAISE EXCEPTION 'Target learning functions changed; review the textbook migration again';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.quizzes'::regclass
      AND conname='quizzes_book_check' AND contype='c') OR
     NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.quizzes'::regclass
      AND conname='quizzes_check4' AND contype='c') OR
     NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.word_mastery'::regclass
      AND conname='word_mastery_book_check' AND contype='c') OR
     NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.word_mastery'::regclass
      AND conname='word_mastery_check' AND contype='c') THEN
    RAISE EXCEPTION 'Target textbook constraints changed; review the migration again';
  END IF;
END $guard$;

ALTER TABLE target_private.quizzes DROP CONSTRAINT quizzes_book_check;
ALTER TABLE target_private.quizzes ADD CONSTRAINT quizzes_book_check
  CHECK(book IN ('target1900','target1000','kobun400'));
ALTER TABLE target_private.quizzes DROP CONSTRAINT quizzes_check4;
ALTER TABLE target_private.quizzes ADD CONSTRAINT quizzes_check4
  CHECK(to_number<=CASE book WHEN 'target1900' THEN 1900 WHEN 'target1000' THEN 1000 WHEN 'kobun400' THEN 400 ELSE 0 END);
ALTER TABLE target_private.word_mastery DROP CONSTRAINT word_mastery_book_check;
ALTER TABLE target_private.word_mastery ADD CONSTRAINT word_mastery_book_check
  CHECK(book IN ('target1900','target1000','kobun400'));
ALTER TABLE target_private.word_mastery DROP CONSTRAINT word_mastery_check;
ALTER TABLE target_private.word_mastery ADD CONSTRAINT word_mastery_check
  CHECK(word_number BETWEEN 1 AND CASE book WHEN 'target1900' THEN 1900 WHEN 'target1000' THEN 1000 WHEN 'kobun400' THEN 400 ELSE 0 END);

-- Keep the existing secret-gated RPC, including every answer, reward, bonus,
-- idempotency and quota branch. Only its textbook allowlists and upper bound
-- change. The source hash and exact replacement counts above/below fail closed.
DO $textbook$
DECLARE definition text; original text; before_list text; after_list text;
BEGIN
  SELECT pg_get_functiondef('public.target_rpc(text,text,jsonb)'::regprocedure) INTO definition;
  original:=definition;
  before_list:='coalesce(p_input->>''book'','''') NOT IN (''target1900'',''target1000'')';
  after_list:='coalesce(p_input->>''book'','''') NOT IN (''target1900'',''target1000'',''kobun400'')';
  IF (length(definition)-length(replace(definition,before_list,'')))/length(before_list)<>2 OR
     (length(definition)-length(replace(definition,'CASE selected_book WHEN ''target1900'' THEN 1900 ELSE 1000 END','')))/
       length('CASE selected_book WHEN ''target1900'' THEN 1900 ELSE 1000 END')<>1 THEN
    RAISE EXCEPTION 'Target textbook validation layout changed';
  END IF;
  definition:=replace(definition,before_list,after_list);
  definition:=replace(definition,'CASE selected_book WHEN ''target1900'' THEN 1900 ELSE 1000 END',
    'CASE selected_book WHEN ''target1900'' THEN 1900 WHEN ''target1000'' THEN 1000 WHEN ''kobun400'' THEN 400 ELSE 0 END');
  IF definition=original THEN RAISE EXCEPTION 'Textbook validation was not changed'; END IF;
  EXECUTE definition;
END $textbook$;

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
  )
  SELECT jsonb_build_object('book',p_book,'sections',(SELECT jsonb_agg(jsonb_build_object(
      'section',s.section,'from',s.first_number,'to',s.last_number,'total',s.last_number-s.first_number+1,
      'mastered',coalesce(c.mastered,0),'percent',coalesce(c.mastered,0)*100/(s.last_number-s.first_number+1),
      'reviewCount',coalesce(c.review_count,0)) ORDER BY s.section)
    FROM sections s LEFT JOIN counts c USING(section)),
    'reviewNumbers',(SELECT coalesce(jsonb_agg(word_number ORDER BY word_number),'[]'::jsonb)
      FROM target_private.word_mastery WHERE member_id=p_member AND book=p_book AND needs_review));
$$;
REVOKE ALL ON FUNCTION target_private.mastery_snapshot(uuid,text) FROM PUBLIC,anon,authenticated;
-- CREATE OR REPLACE retains the existing secret-gated RPC owner and ACL. Repeat
-- its intended grants explicitly, adding no endpoint and no table grants.
REVOKE ALL ON FUNCTION public.target_rpc(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.target_rpc(text,text,jsonb) TO anon;
