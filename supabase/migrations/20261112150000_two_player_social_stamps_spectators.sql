-- Logged-in KGS members may watch currently funded soccer matches and
-- players may send one of five exact preapproved text stamps.
-- Spectators cannot fund, submit inputs, settle, change teams, or reveal room
-- codes, private session tokens, wallet values, claim tokens, or hidden inputs.
-- Ephemeral rows are physically pruned by pg_cron; no long-term replay copies.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
CREATE TABLE target_private.two_player_social_viewers (
  match_id uuid NOT NULL REFERENCES target_private.two_player_matches(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 20),
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id,member_id)
);
CREATE INDEX two_player_social_viewers_seen_idx ON target_private.two_player_social_viewers(seen_at);
CREATE TABLE target_private.two_player_social_stamps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES target_private.two_player_matches(id) ON DELETE RESTRICT,
  actor uuid NOT NULL,
  actor_side text NOT NULL CHECK (actor_side IN ('host','guest')),
  stamp_id smallint NOT NULL CHECK(stamp_id BETWEEN 1 AND 5),
  sent_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX two_player_social_stamps_recent_idx
 ON target_private.two_player_social_stamps(match_id,id DESC);
CREATE INDEX two_player_social_stamps_expiry_idx
 ON target_private.two_player_social_stamps(sent_at);
ALTER TABLE target_private.two_player_social_viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.two_player_social_stamps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON target_private.two_player_social_viewers FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON target_private.two_player_social_stamps FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE target_private.two_player_social_stamps_id_seq FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION target_private.two_player_social_feed(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $feed$
 SELECT jsonb_build_object(
  'viewers',coalesce((SELECT jsonb_agg(v.name ORDER BY v.seen_at DESC,v.member_id)
      FROM (SELECT name,seen_at,member_id FROM target_private.two_player_social_viewers
        WHERE match_id=p_id AND seen_at>clock_timestamp()-interval '35 seconds'
        ORDER BY seen_at DESC LIMIT 20) v),'[]'::jsonb),
  'stamp',(SELECT jsonb_build_object('id',e.id::text,'stampId',e.stamp_id,
    'fromName',CASE WHEN e.actor_side='host' THEN m.host_name ELSE m.guest_name END,
    'sentAt',e.sent_at)
    FROM target_private.two_player_social_stamps e
    JOIN target_private.two_player_matches m ON m.id=e.match_id
    WHERE e.match_id=p_id AND e.sent_at>clock_timestamp()-interval '12 seconds'
    ORDER BY e.id DESC LIMIT 1)
 );
$feed$;
REVOKE ALL ON FUNCTION target_private.two_player_social_feed(uuid)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.two_player_social_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $social$
DECLARE
  actor_id uuid;
  actor_name text;
  game_id uuid;
  played target_private.two_player_matches%rowtype;
  action_keys integer;
  m jsonb;
  r jsonb;
  stamp_code integer;
  last_round integer:=0;
  last_stamp timestamptz;
  stamp_count integer;
  stamp_record target_private.two_player_social_stamps%rowtype;
  matches jsonb;
BEGIN
  -- Authenticate the fixed server secret before interpreting the payload or
  -- touching social tables. No browser directly possesses this secret.
  IF p_secret IS NULL OR length(p_secret) NOT BETWEEN 32 AND 256
   OR NOT EXISTS(SELECT 1 FROM target_private.two_player_credentials
      WHERE singleton AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex'))
  THEN RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。'); END IF;
  IF p_action NOT IN ('list','watch','feed','stamp','leave') OR
      p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR
      pg_column_size(p_input)>2048 OR
      jsonb_typeof(p_input->'memberId') IS DISTINCT FROM 'string' OR
      coalesce(p_input->>'memberId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' OR
      jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR
      length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 20
  THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
  action_keys:=(SELECT count(*) FROM jsonb_object_keys(p_input));
  IF (p_action='list' AND (action_keys<>2 OR NOT(p_input?'memberId' AND p_input?'name'))) OR
     (p_action IN ('feed','leave') AND (action_keys<>3 OR NOT (p_input?'matchId'))) OR
     (p_action='watch' AND (action_keys<>4 OR NOT(p_input?'matchId' AND p_input?'afterRound'))) OR
     (p_action='stamp' AND (action_keys<>4 OR NOT(p_input?'matchId' AND p_input?'stampId')))
  THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
  actor_id:=(p_input->>'memberId')::uuid;
  actor_name:=btrim(p_input->>'name');
  IF p_action='list' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',s.id,'host',s.host_name,'guest',s.guest_name,
      'scores',jsonb_build_object('host',s.host_score,'guest',s.guest_score),
      'round',s.round) ORDER BY s.created_at DESC),'[]'::jsonb) INTO matches
    FROM (SELECT id,host_name,guest_name,host_score,guest_score,round,created_at
      FROM target_private.two_player_matches WHERE status='playing' AND
      expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 25) s;
    RETURN jsonb_build_object('ok',true,'games',matches);
  END IF;
  IF jsonb_typeof(p_input->'matchId') IS DISTINCT FROM 'string' OR
      coalesce(p_input->>'matchId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  THEN RETURN target_private.error_result(400,'INVALID_REQUEST','試合を確認してください。'); END IF;
  game_id:=(p_input->>'matchId')::uuid;
  IF p_action='watch' AND (jsonb_typeof(p_input->'afterRound')<>'number'
      OR coalesce(p_input->>'afterRound','') !~ '^[0-9]{1,10}$'
      OR (p_input->>'afterRound')::numeric>2147483647)
  THEN RETURN target_private.error_result(400,'INVALID_REQUEST','観戦情報を確認してください。'); END IF;
  IF p_action='stamp' AND (jsonb_typeof(p_input->'stampId')<>'number'
      OR coalesce(p_input->>'stampId','') !~ '^[1-5]$')
  THEN RETURN target_private.error_result(400,'INVALID_REQUEST','スタンプを確認してください。'); END IF;
  IF p_action='leave' THEN
    DELETE FROM target_private.two_player_social_viewers
      WHERE match_id=game_id AND member_id=actor_id;
    RETURN jsonb_build_object('ok',true);
  END IF;

  SELECT * INTO played FROM target_private.two_player_matches WHERE id=game_id;
  IF NOT FOUND OR played.status<>'playing' OR played.expires_at<=clock_timestamp() THEN
    RETURN target_private.error_result(404,'MATCH_NOT_FOUND','観戦できる試合はありません。');
  END IF;
  IF p_action IN ('feed','stamp') THEN
    IF actor_id IS DISTINCT FROM played.host_id AND actor_id IS DISTINCT FROM played.guest_id THEN
      RETURN target_private.error_result(403,'NOT_PARTICIPANT','この操作は対戦中の二人のみ利用できます。');
    END IF;
    IF p_action='feed' THEN RETURN jsonb_build_object('ok',true,
      'social',target_private.two_player_social_feed(game_id)); END IF;

    -- Stamp actions never touch match state or financial receipts. The per-user
    -- advisory lock makes the 5-second cooldown atomic across concurrent calls.
    PERFORM pg_advisory_xact_lock(hashtext(game_id::text),hashtext(actor_id::text));
    SELECT max(sent_at),count(*)::integer INTO last_stamp,stamp_count
      FROM target_private.two_player_social_stamps
      WHERE match_id=game_id AND actor=actor_id;
    IF (last_stamp IS NOT NULL AND last_stamp>clock_timestamp()-interval '5 seconds') OR stamp_count>=30 THEN
      RETURN target_private.error_result(429,'STAMP_RATE_LIMIT','スタンプを送れるまで少しお待ちください。');
    END IF;
    stamp_code:=(p_input->>'stampId')::integer;
    INSERT INTO target_private.two_player_social_stamps(match_id,actor,actor_side,stamp_id)
      VALUES(game_id,actor_id,CASE WHEN actor_id=played.host_id THEN 'host' ELSE 'guest' END,stamp_code)
      RETURNING * INTO stamp_record;
    RETURN jsonb_build_object('ok',true,'stamp',jsonb_build_object(
       'id',stamp_record.id::text,'stampId',stamp_record.stamp_id,
       'fromName',CASE WHEN stamp_record.actor_side='host' THEN played.host_name ELSE played.guest_name END,
       'sentAt',stamp_record.sent_at));
  END IF;

  -- Spectator must not be one of the players nor in their own active match.
  IF actor_id=played.host_id OR actor_id=played.guest_id OR EXISTS (
    SELECT 1 FROM target_private.two_player_matches t WHERE t.status='playing'
      AND t.expires_at>clock_timestamp() AND (t.host_id=actor_id OR t.guest_id=actor_id)
  ) THEN RETURN target_private.error_result(403,'SPECTATOR_FORBIDDEN','対戦中はほかの試合を観戦できません。'); END IF;
  last_round:=(p_input->>'afterRound')::integer;
  INSERT INTO target_private.two_player_social_viewers(match_id,member_id,name)
    VALUES(game_id,actor_id,actor_name)
    ON CONFLICT (match_id,member_id) DO UPDATE
       SET name=EXCLUDED.name,seen_at=clock_timestamp();
  -- Only the last resolved shot is returned, when newer than the last one
  -- the caller already saw. The entire private match DTO must NOT be exposed.
  SELECT jsonb_build_object(
    'id',played.id,'status',played.status,'turn',played.turn,'round',played.round,
    'version',played.version,'host',jsonb_build_object('name',played.host_name),
    'guest',jsonb_build_object('name',played.guest_name),
    'scores',jsonb_build_object('host',played.host_score,'guest',played.guest_score),
    'state',played.state,'turnStartedAt',played.turn_started_at,
    'turnExpiresAt',played.turn_expires_at,'serverNow',clock_timestamp(),
    'winner',played.winner,'reason',played.reason,
    'lastRound',(SELECT jsonb_build_object('round',x.round,'frames',x.frames,'goal',x.goal)
       FROM target_private.two_player_moves x WHERE x.match_id=played.id
         AND x.resolved_at IS NOT NULL AND x.round>last_round
       ORDER BY x.round DESC LIMIT 1)
    ) INTO m;
  RETURN jsonb_build_object('ok',true,'match',m,
    'social',target_private.two_player_social_feed(game_id));
END $social$;
REVOKE ALL ON FUNCTION public.two_player_social_rpc(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.two_player_social_rpc(text,text,jsonb)
 TO anon,authenticated,service_role;

CREATE FUNCTION target_private.two_player_social_cleanup()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $clean$
BEGIN
 DELETE FROM target_private.two_player_social_viewers
   WHERE seen_at<clock_timestamp()-interval '35 seconds'
      OR NOT EXISTS (SELECT 1 FROM target_private.two_player_matches m
        WHERE m.id=match_id AND m.status='playing');
 DELETE FROM target_private.two_player_social_stamps
   WHERE sent_at<clock_timestamp()-interval '10 minutes';
END $clean$;
REVOKE ALL ON FUNCTION target_private.two_player_social_cleanup()
 FROM PUBLIC,anon,authenticated,service_role;
DO $cron$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
   IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='two-player-social-cleanup') THEN
     PERFORM cron.schedule('two-player-social-cleanup','*/5 * * * *',
       'SELECT target_private.two_player_social_cleanup()');
   END IF;
 END IF;
END $cron$;
NOTIFY pgrst,'reload schema';
COMMIT;
