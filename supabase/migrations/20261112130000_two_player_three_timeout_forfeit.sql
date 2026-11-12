-- Fail a player after three consecutive *own-turn* 60-second expirations,
-- if the opponent has played a real shot during that streak.
-- When neither player participates, keep the ten-minute idle refund instead.
-- This is an additive funded-match rule; historic matches and receipts stay.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);

DO $hash_guard$
DECLARE x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('target_private.two_player_advance_turn(uuid,integer)','a25258beceff1f0747c97dd275bc333b'),
   ('target_private.two_player_settle(uuid,text,text,text)','21c21d2d34d4ffda68263fde9e9aa7ba'),
   ('target_private.two_player_expire(uuid,integer)','ff595d6a469ce8c7a3156b719d0db6fa'),
   ('target_private.two_player_match_dto(uuid,boolean)','47fb22ebd189fe67249b1ba2bb127f35'),
   ('public.two_player_ranking_rpc(text,text,jsonb)','e0153893b4485f5d5bcd089642538b1e'),
   ('target_private.two_player_validate_money()','6ea6717846d69a24a91e47758f8818b5'),
   ('target_private.two_player_turn_clock()','8c5857cb963477c3432cf02787b40db5')
 ) AS checks(signature,expected_md5) LOOP
   IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=x.signature::regprocedure)
     IS DISTINCT FROM x.expected_md5 THEN
     RAISE EXCEPTION 'Reviewed soccer boundary changed: %',x.signature;
   END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='two_player_move_version'
     AND tgenabled='O' AND tgrelid='target_private.two_player_moves'::regclass)
   OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='two_player_funded_stakes'
     AND tgenabled='O' AND tgrelid='target_private.two_player_matches'::regclass)
 THEN RAISE EXCEPTION 'Soccer trigger safety boundary missing'; END IF;
END $hash_guard$;

ALTER TABLE target_private.two_player_matches
  ADD COLUMN host_timeout_streak smallint NOT NULL DEFAULT 0,
  ADD COLUMN guest_timeout_streak smallint NOT NULL DEFAULT 0,
  ADD CONSTRAINT two_player_host_timeout_streak_check CHECK(host_timeout_streak BETWEEN 0 AND 3),
  ADD CONSTRAINT two_player_guest_timeout_streak_check CHECK(guest_timeout_streak BETWEEN 0 AND 3);

-- A shot is valid only after the original BEFORE INSERT deadline and turn
-- validation succeeds. The reset is transactional and happens exactly once.
CREATE FUNCTION target_private.two_player_reset_timeout_streak()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog AS $reset$
BEGIN
 IF NEW.actor='host' THEN
   UPDATE target_private.two_player_matches SET host_timeout_streak=0
   WHERE id=NEW.match_id AND status='playing' AND round=NEW.round
     AND host_timeout_streak>0;
 ELSIF NEW.actor='guest' THEN
   UPDATE target_private.two_player_matches SET guest_timeout_streak=0
   WHERE id=NEW.match_id AND status='playing' AND round=NEW.round
     AND guest_timeout_streak>0;
 END IF;
 RETURN NULL;
END $reset$;
REVOKE ALL ON FUNCTION target_private.two_player_reset_timeout_streak()
  FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER two_player_reset_timeout_streak
AFTER INSERT ON target_private.two_player_moves
FOR EACH ROW EXECUTE FUNCTION target_private.two_player_reset_timeout_streak();

-- Former code batched N timed-out turns, losing which individual timed out.
-- Replaying each deadline in order is at most ten 60-second steps before
-- the existing ten-minute inactive-match refund. We do not update expires_at.
CREATE OR REPLACE FUNCTION target_private.two_player_advance_turn(
  p_member uuid DEFAULT NULL::uuid,p_limit integer DEFAULT 100
) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog AS $advance$
DECLARE
  selected record;
  m target_private.two_player_matches%rowtype;
  now_value timestamptz:=clock_timestamp();
  passes bigint;
  n bigint;
  next_streak integer;
  opponent_played boolean;
  changed integer:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  FOR selected IN
    SELECT r.id FROM target_private.two_player_matches r JOIN (
      SELECT a.match_id AS id FROM target_private.two_player_participants a
        WHERE a.member_id=p_member
      UNION
      SELECT g.id FROM target_private.two_player_matches g
        WHERE p_member IS NULL AND g.status='playing'
          AND g.turn_expires_at<=now_value
    ) selected_ids ON selected_ids.id=r.id
    WHERE r.status='playing' AND r.turn_expires_at<=now_value
      AND r.expires_at>now_value
      AND NOT EXISTS (SELECT 1 FROM target_private.two_player_moves x
        WHERE x.match_id=r.id AND x.round=r.round AND x.resolved_at IS NULL)
    ORDER BY r.turn_expires_at
    LIMIT least(greatest(p_limit,1),100)
    FOR UPDATE OF r
  LOOP
    SELECT * INTO STRICT m FROM target_private.two_player_matches
      WHERE id=selected.id FOR UPDATE;
    passes:=floor(extract(epoch FROM (now_value-m.turn_expires_at))/60)::bigint+1;
    IF m.round::bigint+passes>2147483647 THEN CONTINUE; END IF;
    -- Protect against unexpected future over-long idle horizons.
    IF passes>16 THEN RAISE EXCEPTION 'Unexpected soccer timeout backlog'; END IF;
    FOR n IN 1..passes LOOP
      EXIT WHEN m.status<>'playing' OR m.turn_expires_at>now_value;
      IF m.turn='host' THEN
        next_streak:=least(3,m.host_timeout_streak+1);
        SELECT EXISTS(SELECT 1 FROM target_private.two_player_moves x
          WHERE x.match_id=m.id AND x.actor='guest'
            AND x.round BETWEEN greatest(1,m.round-4) AND m.round
            AND x.resolved_at IS NOT NULL) INTO opponent_played;
        IF next_streak=3 AND opponent_played THEN
          UPDATE target_private.two_player_matches
            SET host_timeout_streak=3 WHERE id=m.id;
          PERFORM target_private.two_player_settle(
            m.id,'finished','guest','three_timeouts');
          EXIT;
        END IF;
        UPDATE target_private.two_player_matches SET
          round=round+1,turn='guest',host_timeout_streak=next_streak,
          turn_started_at=m.turn_expires_at,
          turn_expires_at=m.turn_expires_at+interval '60 seconds'
        WHERE id=m.id;
      ELSE
        next_streak:=least(3,m.guest_timeout_streak+1);
        SELECT EXISTS(SELECT 1 FROM target_private.two_player_moves x
          WHERE x.match_id=m.id AND x.actor='host'
            AND x.round BETWEEN greatest(1,m.round-4) AND m.round
            AND x.resolved_at IS NOT NULL) INTO opponent_played;
        IF next_streak=3 AND opponent_played THEN
          UPDATE target_private.two_player_matches
            SET guest_timeout_streak=3 WHERE id=m.id;
          PERFORM target_private.two_player_settle(
            m.id,'finished','host','three_timeouts');
          EXIT;
        END IF;
        UPDATE target_private.two_player_matches SET
          round=round+1,turn='host',guest_timeout_streak=next_streak,
          turn_started_at=m.turn_expires_at,
          turn_expires_at=m.turn_expires_at+interval '60 seconds'
        WHERE id=m.id;
      END IF;
      SELECT * INTO STRICT m FROM target_private.two_player_matches
        WHERE id=selected.id FOR UPDATE;
    END LOOP;
    changed:=changed+1;
  END LOOP;
  RETURN changed;
END $advance$;
REVOKE ALL ON FUNCTION target_private.two_player_advance_turn(uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;

-- Add read-only metadata to the existing trusted match DTO.
DO $dto$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('target_private.two_player_match_dto(uuid,boolean)'::regprocedure)
 INTO definition;
 IF (length(definition)-length(replace(definition,
     '''cancelRequested'',m.host_cancel)', '')))
     <>length('''cancelRequested'',m.host_cancel)')
 OR (length(definition)-length(replace(definition,
     '''cancelRequested'',m.guest_cancel)', '')))
     <>length('''cancelRequested'',m.guest_cancel)')
 THEN RAISE EXCEPTION 'Match DTO shape changed'; END IF;
 definition:=replace(definition,'''cancelRequested'',m.host_cancel)',
    '''cancelRequested'',m.host_cancel,''timeoutStreak'',m.host_timeout_streak)');
 definition:=replace(definition,'''cancelRequested'',m.guest_cancel)',
    '''cancelRequested'',m.guest_cancel,''timeoutStreak'',m.guest_timeout_streak)');
 EXECUTE definition;
END $dto$;

-- A 3-timeout victory is +1 win/+1 point, without fabricating any goals.
-- Existing 3–0/3–1/3–2 points and loss/no-deduction rules are unchanged.
DO $ranking$
DECLARE definition text;
  old_points text := '3-CASE WHEN m.winner=''host'' THEN m.guest_score ELSE m.host_score END AS points';
  new_points text := 'CASE WHEN m.reason=''three_timeouts'' THEN 1 ELSE 3-CASE WHEN m.winner=''host'' THEN m.guest_score ELSE m.host_score END END AS points';
  old_filter text :=
    'AND ((m.winner=''host'' AND m.host_score=3 AND m.guest_score BETWEEN 0 AND 2)'||chr(10)||
    '        OR (m.winner=''guest'' AND m.guest_score=3 AND m.host_score BETWEEN 0 AND 2))';
  new_filter text :=
    'AND ((m.reason=''three_timeouts'' AND m.winner IN (''host'',''guest'') AND m.host_score BETWEEN 0 AND 2 AND m.guest_score BETWEEN 0 AND 2)'||chr(10)||
    '        OR (m.winner=''host'' AND m.host_score=3 AND m.guest_score BETWEEN 0 AND 2)'||chr(10)||
    '        OR (m.winner=''guest'' AND m.guest_score=3 AND m.host_score BETWEEN 0 AND 2))';
BEGIN
 SELECT pg_get_functiondef('public.two_player_ranking_rpc(text,text,jsonb)'::regprocedure)
 INTO definition;
 IF (length(definition)-length(replace(definition,old_points,'')))<>length(old_points)
   OR (length(definition)-length(replace(definition,old_filter,'')))<>length(old_filter)
 THEN RAISE EXCEPTION 'Ranking contract changed; review required'; END IF;
 definition:=replace(replace(definition,old_points,new_points),old_filter,new_filter);
 EXECUTE definition;
END $ranking$;

-- The cron checks match turn windows every minute even if the winner is not
-- polling. It cannot produce an idle-only win: a real opponent shot is needed.
DO $schedule$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
   IF NOT EXISTS(SELECT 1 FROM cron.job
     WHERE jobname='two-player-soccer-forfeit-turns') THEN
     PERFORM cron.schedule('two-player-soccer-forfeit-turns','* * * * *',
       'SELECT target_private.two_player_advance_turn(NULL,100)');
   END IF;
 END IF;
END $schedule$;
COMMENT ON FUNCTION target_private.two_player_advance_turn(uuid,integer) IS
 'Pass missed 60-second turns atomically; after three own-turn misses a recent, active opponent wins. Both-idle matches still refund after ten minutes.';
NOTIFY pgrst,'reload schema';
COMMIT;
