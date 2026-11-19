-- Generated with Supabase CLI migration new target_study_only_ranking.
-- Read-only ranking calculation only: retain wallets, award receipts, spending,
-- restoration history, profiles, identity, RLS and existing function grants.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock(991101);

DO $ranking$
DECLARE
 definition text; source text;
 old_branch text:=$old$  IF p_action='ranking' THEN
    IF p_input<>'{}'::jsonb THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
    SELECT jsonb_build_object('ranking',coalesce(jsonb_agg(result_value ORDER BY row_rank),'[]'::jsonb),
      'updatedAt',clock_timestamp()) INTO response_value FROM (
      SELECT row_number() OVER(ORDER BY total_points DESC,correct_count DESC,answered_count ASC,updated_at ASC,member_id ASC) AS row_rank,
        jsonb_build_object('rank',row_number() OVER(ORDER BY total_points DESC,correct_count DESC,answered_count ASC,updated_at ASC,member_id ASC),
          'name',name,'correctCount',correct_count,'totalPoints',total_points) AS result_value
      FROM target_private.profiles WHERE answered_count>0
      ORDER BY total_points DESC,correct_count DESC,answered_count ASC,updated_at ASC,member_id ASC LIMIT 500
    ) ranked;
    RETURN response_value;
  END IF;$old$;
 new_branch text:=$new$  IF p_action='ranking' THEN
    IF p_input<>'{}'::jsonb THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
    -- Use the canonical normal-study component, including bonuses and prior
    -- study restorations. Non-study income and spending never affect it.
    SELECT jsonb_build_object('ranking',coalesce(jsonb_agg(result_value ORDER BY row_rank),'[]'::jsonb),
      'updatedAt',clock_timestamp()) INTO response_value FROM (
      SELECT row_number() OVER(ORDER BY study_points DESC,correct_count DESC,answered_count ASC,member_id ASC) AS row_rank,
        jsonb_build_object('rank',row_number() OVER(ORDER BY study_points DESC,correct_count DESC,answered_count ASC,member_id ASC),
          'name',name,'correctCount',correct_count,'totalPoints',study_points) AS result_value
      FROM (
        SELECT member_id,name,correct_count,answered_count,
          total_points-calculus_points-birthday_points-casino_net-calculus_forgiven_points AS study_points
        FROM target_private.profiles WHERE answered_count>0
      ) study_scores
      ORDER BY study_points DESC,correct_count DESC,answered_count ASC,member_id ASC LIMIT 500
    ) ranked;
    RETURN response_value;
  END IF;$new$;
BEGIN
 SELECT pg_get_functiondef(oid),prosrc INTO definition,source
 FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure;
 IF md5(source)<>'b23ee976ec11ad3d3622d0011b1ec810' OR
   (length(source)-length(replace(source,old_branch,'')))/length(old_branch)<>1 THEN
  RAISE EXCEPTION 'Target ranking differs from the reviewed source';
 END IF;
 EXECUTE replace(definition,old_branch,new_branch);
 IF (SELECT prosrc FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure)
     IS DISTINCT FROM replace(source,old_branch,new_branch) THEN
  RAISE EXCEPTION 'Target non-ranking source unexpectedly changed';
 END IF;
END $ranking$;

NOTIFY pgrst,'reload schema';
COMMIT;
