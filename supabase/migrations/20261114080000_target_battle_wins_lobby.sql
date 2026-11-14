-- Read-only ranking for Target HP quiz battle. Count actual completed victories;
-- never rank by wallet balance, acquired 轟, score, or client-provided numbers.
-- Existing Target mastery, soccer and wallet receipts are not modified.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);

DO $verify$
BEGIN
  IF to_regclass('target_private.battle_matches') IS NULL OR
     to_regprocedure('public.target_battle_rpc(text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Target HP battle schema is required before rankings'; END IF;
END $verify$;

CREATE FUNCTION target_private.battle_wins_ranking()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $wins$
  WITH participants AS (
    SELECT m.host_id AS member_id, (m.winner='host') AS won
    FROM target_private.battle_matches m WHERE m.status='finished'
    UNION ALL
    SELECT m.guest_id AS member_id, (m.winner='guest') AS won
    FROM target_private.battle_matches m WHERE m.status='finished'
  ), totals AS (
    SELECT member_id, count(*) FILTER (WHERE won)::integer AS wins
    FROM participants GROUP BY member_id
  ), ranked AS (
    SELECT p.member_id, p.name, t.wins,
      rank() OVER (ORDER BY t.wins DESC)::integer AS standing
    FROM totals t JOIN target_private.profiles p ON p.member_id=t.member_id
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object('id',r.member_id,'name',r.name,
                       'wins',r.wins,'rank',r.standing)
    ORDER BY r.wins DESC,lower(r.name),r.member_id),'[]'::jsonb)
  FROM (SELECT * FROM ranked ORDER BY wins DESC,lower(name),member_id LIMIT 100) r;
$wins$;
REVOKE ALL ON FUNCTION target_private.battle_wins_ranking()
  FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION target_private.battle_wins_ranking() IS
  'Read-only, server-only Target HP battle ranking by actual finished-match victories; draws and cancellations never award wins.';

-- Keep all existing security, authentication, stake and settlement rules:
-- modify only the authenticated lobby DTO construction in the existing RPC.
DO $patch$
DECLARE source text; needle text; replacement text; occurrences integer;
BEGIN
  SELECT pg_get_functiondef('public.target_battle_rpc(text,text,jsonb)'::regprocedure)
    INTO source;
  needle:='''online'',coalesce((SELECT jsonb_agg(';
  replacement:='''ranking'',target_private.battle_wins_ranking(),' ||
      chr(10) || '      ''online'',coalesce((SELECT jsonb_agg(';
  occurrences:=(length(source)-length(replace(source,needle,'')))/length(needle);
  IF occurrences<>1 OR position('target_private.battle_wins_ranking()' IN source)<>0 THEN
    RAISE EXCEPTION 'Battle RPC lobby signature changed; refuse unsafe patch'; END IF;
  EXECUTE replace(source,needle,replacement);
  IF NOT has_function_privilege('anon','public.target_battle_rpc(text,text,jsonb)','EXECUTE') OR
     has_function_privilege('authenticated','public.target_battle_rpc(text,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'Battle RPC role boundary changed'; END IF;
END $patch$;

COMMIT;
