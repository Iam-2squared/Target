-- Authenticated KGS profiles can read only their own permanent Target
-- Section 100% achievements, using the established private RPC secret.
-- No learner mastery values, words, finance, or historical records are changed.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='60s';
DO $guard$
BEGIN
 IF to_regclass('target_private.section_mastery_achievements') IS NULL OR
    to_regclass('target_private.server_credentials') IS NULL OR
    NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='target_private.section_mastery_achievements'::regclass
      AND conname='section_mastery_achievements_pkey')
 THEN RAISE EXCEPTION 'Canonical mastery achievement source unavailable'; END IF;
END $guard$;

CREATE FUNCTION public.target_badge_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $body$
DECLARE
  learner uuid;
  badge_ids text[];
  completed integer;
BEGIN
  IF p_secret IS NULL OR length(p_secret) NOT BETWEEN 32 AND 512 OR
    NOT EXISTS(SELECT 1 FROM target_private.server_credentials
      WHERE singleton=true AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex'))
  THEN RETURN jsonb_build_object('error',jsonb_build_object(
    'status',403,'code','RPC_FORBIDDEN','message','認証されていません。')); END IF;
  IF p_action IS DISTINCT FROM 'list' OR p_input IS NULL OR
    jsonb_typeof(p_input)<>'object' OR pg_column_size(p_input)>1024 OR
    (SELECT count(*) FROM jsonb_object_keys(p_input))<>2 OR
    NOT (p_input?'memberId' AND p_input?'name') OR
    jsonb_typeof(p_input->'memberId')<>'string' OR
    coalesce(p_input->>'memberId','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR
    jsonb_typeof(p_input->'name')<>'string' OR
    length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 20
  THEN RETURN jsonb_build_object('error',jsonb_build_object(
    'status',400,'code','INVALID_REQUEST','message','送信内容を確認してください。')); END IF;
  learner:=(p_input->>'memberId')::uuid;

  -- A Section badge is earned by the existing transactional 100-of-100
  -- achievement trigger, never by user-reported percentages. Book and grand
  -- badges require every canonical Section to have been achieved at least once.
  WITH achievements AS (
    SELECT book,section FROM target_private.section_mastery_achievements
    WHERE member_id=learner
  ), parts AS (
    SELECT 'sec:'||book||':'||lpad(section::text,2,'0') AS id,
      CASE book WHEN 'target1900' THEN 100 WHEN 'target1000' THEN 200 ELSE 300 END+section AS ord
    FROM achievements
  ), books AS (
    SELECT material,needed,ord FROM (VALUES
      ('target1900'::text,19,401),('target1000'::text,10,402),('kobun400'::text,4,403)
    ) x(material,needed,ord)
    WHERE (SELECT count(*) FROM achievements a WHERE a.book=x.material)=x.needed
  ), extras AS (
    SELECT 'book:'||material AS id,ord FROM books
    UNION ALL
    SELECT 'grand:all',500 WHERE (SELECT count(*) FROM achievements)=33
      AND (SELECT count(*) FROM books)=3
  ), combined AS (
    SELECT id,ord FROM parts UNION ALL SELECT id,ord FROM extras
  )
  SELECT coalesce(array_agg(id ORDER BY ord),'{}'::text[])
  INTO badge_ids FROM combined;
  SELECT count(*)::integer INTO completed FROM target_private.section_mastery_achievements
   WHERE member_id=learner;
  RETURN jsonb_build_object('ok',true,'earnedIds',to_jsonb(badge_ids),
    'completedSections',completed,'sectionTotal',33);
END $body$;
REVOKE ALL ON FUNCTION public.target_badge_rpc(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.target_badge_rpc(text,text,jsonb) TO anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
