-- Generated with Supabase CLI migration new target_two_player_turn_clock.
-- Gameplay-only cutover: no ledger, wallet, inventory or historical receipt rewrite.
BEGIN;
SELECT pg_advisory_xact_lock(991101);
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.two_player_rpc(text,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '640f070ee4aae1d25910ab58b8284648' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.two_player_initial_state(integer,integer)'::regprocedure)
      IS DISTINCT FROM '2358e90576964049d2979b1c7d1b81d5' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
      IS DISTINCT FROM '8e69577732c1f54b2dae637b87aa3fd6' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_games_rpc(text,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '71ddbc56e79a79dcd8a046d556b73a59' THEN
    RAISE EXCEPTION 'Reviewed turn-rule or financial boundary changed'; END IF;
END $guard$;

ALTER TABLE target_private.two_player_matches
  DROP CONSTRAINT two_player_matches_round_check,
  ADD CONSTRAINT two_player_matches_round_check CHECK(round>=1),
  ADD COLUMN turn_started_at timestamptz,
  ADD COLUMN turn_expires_at timestamptz,
  ADD CONSTRAINT two_player_turn_clock_check CHECK(
    (status='playing' AND turn_started_at IS NOT NULL AND turn_expires_at IS NOT NULL AND turn_expires_at=turn_started_at+interval '60 seconds') OR
    (status<>'playing' AND turn_started_at IS NULL AND turn_expires_at IS NULL)) NOT VALID;
ALTER TABLE target_private.two_player_moves
  DROP CONSTRAINT two_player_moves_round_check,
  ADD CONSTRAINT two_player_moves_round_check CHECK(round>=1),
  ADD COLUMN turn_rules boolean NOT NULL DEFAULT false;

-- Deterministic V2 turn-boundary cleanup. All geometry uses integer thousandths.
-- Valid stored soccer state is expected; no table access or financial writes.
CREATE FUNCTION target_private.two_player_clear_goal_areas(p_state jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  piece_x bigint[]:=array_fill(0::bigint,ARRAY[16]);
  piece_y bigint[]:=array_fill(0::bigint,ARRAY[16]);
  ball_x bigint; ball_y bigint;
  end_index integer; canonical_index integer; piece_index integer;
  obstacle_index integer; candidate_index integer; grid_index integer;
  origin_x bigint; origin_y bigint; candidate_x bigint; candidate_y bigint;
  obstacle_x bigint; obstacle_y bigint; relative_ball_x bigint; relative_ball_y bigint;
  difference_x bigint; difference_y bigint; distance_squared bigint;
  best_x bigint; best_y bigint; best_distance bigint;
  candidate_valid boolean; found_candidate boolean;
  output_players jsonb:='[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_state->'players') IS DISTINCT FROM 'array' OR
      jsonb_array_length(p_state->'players')<>16 THEN
    RAISE EXCEPTION 'Invalid soccer state' USING ERRCODE='22023';
  END IF;
  FOR piece_index IN 1..16 LOOP
    piece_x[piece_index]:=round((p_state->'players'->(piece_index-1)->>'x')::numeric*1000)::bigint;
    piece_y[piece_index]:=round((p_state->'players'->(piece_index-1)->>'y')::numeric*1000)::bigint;
    IF piece_x[piece_index] IS NULL OR piece_y[piece_index] IS NULL THEN
      RAISE EXCEPTION 'Invalid soccer state' USING ERRCODE='22023';
    END IF;
  END LOOP;
  ball_x:=round((p_state->'ball'->>'x')::numeric*1000)::bigint;
  ball_y:=round((p_state->'ball'->>'y')::numeric*1000)::bigint;
  IF ball_x IS NULL OR ball_y IS NULL THEN
    RAISE EXCEPTION 'Invalid soccer state' USING ERRCODE='22023';
  END IF;

  -- End 0 is the bottom goal; end 1 rotates coordinates and seat order.
  -- Their fallback rows remain 60px apart, so clearing the ends is independent.
  FOR end_index IN 0..1 LOOP
    relative_ball_x:=CASE WHEN end_index=0 THEN ball_x ELSE 640000-ball_x END;
    relative_ball_y:=CASE WHEN end_index=0 THEN ball_y ELSE 960000-ball_y END;
    FOR canonical_index IN 0..15 LOOP
      piece_index:=CASE WHEN end_index=0 THEN canonical_index+1 ELSE (canonical_index+8)%16+1 END;
      origin_x:=CASE WHEN end_index=0 THEN piece_x[piece_index] ELSE 640000-piece_x[piece_index] END;
      origin_y:=CASE WHEN end_index=0 THEN piece_y[piece_index] ELSE 960000-piece_y[piece_index] END;
      IF origin_x<=196000 OR origin_x>=444000 OR origin_y<=846000 THEN
        CONTINUE;
      END IF;

      found_candidate:=false;
      best_distance:=NULL;
      -- Exact edge projections first, then the 7x11 inward grid in row order.
      -- At most 16 other bodies can obstruct the 77 grid nodes; a body can
      -- obstruct at most four nodes at the chosen 56px spacing.
      FOR candidate_index IN 0..79 LOOP
        IF candidate_index=0 THEN
          candidate_x:=origin_x; candidate_y:=846000;
        ELSIF candidate_index=1 THEN
          candidate_x:=196000; candidate_y:=origin_y;
        ELSIF candidate_index=2 THEN
          candidate_x:=444000; candidate_y:=origin_y;
        ELSE
          grid_index:=candidate_index-3;
          candidate_x:=28000+56000*(grid_index%11);
          candidate_y:=846000-56000*(grid_index/11);
        END IF;
        difference_x:=candidate_x-origin_x;
        difference_y:=candidate_y-origin_y;
        distance_squared:=difference_x*difference_x+difference_y*difference_y;
        IF found_candidate AND distance_squared>=best_distance THEN CONTINUE; END IF;

        difference_x:=candidate_x-relative_ball_x;
        difference_y:=candidate_y-relative_ball_y;
        candidate_valid:=difference_x*difference_x+difference_y*difference_y>=1764000000;
        IF candidate_valid THEN
          FOR obstacle_index IN 1..16 LOOP
            IF obstacle_index=piece_index THEN CONTINUE; END IF;
            obstacle_x:=CASE WHEN end_index=0 THEN piece_x[obstacle_index] ELSE 640000-piece_x[obstacle_index] END;
            obstacle_y:=CASE WHEN end_index=0 THEN piece_y[obstacle_index] ELSE 960000-piece_y[obstacle_index] END;
            difference_x:=candidate_x-obstacle_x;
            difference_y:=candidate_y-obstacle_y;
            IF difference_x*difference_x+difference_y*difference_y<3136000000 THEN
              candidate_valid:=false;
              EXIT;
            END IF;
          END LOOP;
        END IF;
        IF candidate_valid THEN
          best_x:=candidate_x; best_y:=candidate_y;
          best_distance:=distance_squared;
          found_candidate:=true;
        END IF;
      END LOOP;
      IF NOT found_candidate THEN
        RAISE EXCEPTION 'Soccer goal area could not be cleared' USING ERRCODE='22023';
      END IF;
      piece_x[piece_index]:=CASE WHEN end_index=0 THEN best_x ELSE 640000-best_x END;
      piece_y[piece_index]:=CASE WHEN end_index=0 THEN best_y ELSE 960000-best_y END;
    END LOOP;
  END LOOP;

  FOR piece_index IN 1..16 LOOP
    output_players:=output_players||jsonb_build_array(jsonb_build_object(
      'x',piece_x[piece_index]::numeric/1000,'y',piece_y[piece_index]::numeric/1000));
  END LOOP;
  RETURN jsonb_set(p_state,'{players}',output_players,false);
END $$;
REVOKE ALL ON FUNCTION target_private.two_player_clear_goal_areas(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;


CREATE FUNCTION target_private.two_player_turn_clock()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE delay_seconds double precision:=0;
BEGIN
  IF NEW.status<>'playing' THEN NEW.turn_started_at:=NULL; NEW.turn_expires_at:=NULL;
  ELSIF TG_OP='INSERT' OR OLD.status<>'playing' THEN
    NEW.turn_started_at:=clock_timestamp(); NEW.turn_expires_at:=NEW.turn_started_at+interval '60 seconds';
    NEW.state:=target_private.two_player_clear_goal_areas(NEW.state);
  ELSIF NEW.round IS DISTINCT FROM OLD.round THEN
    IF NEW.turn_expires_at IS NOT DISTINCT FROM OLD.turn_expires_at THEN
      SELECT least(6::double precision,greatest(0::double precision,(jsonb_array_length(x.frames)-1)::double precision/20))
        INTO delay_seconds FROM target_private.two_player_moves x
        WHERE x.match_id=NEW.id AND x.round=OLD.round AND x.resolved_at IS NOT NULL;
      NEW.turn_started_at:=clock_timestamp()+coalesce(delay_seconds,0)*interval '1 second';
      NEW.turn_expires_at:=NEW.turn_started_at+interval '60 seconds';
    END IF;
    NEW.state:=target_private.two_player_clear_goal_areas(NEW.state);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION target_private.two_player_turn_clock() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER two_player_turn_clock BEFORE INSERT OR UPDATE ON target_private.two_player_matches
  FOR EACH ROW EXECUTE FUNCTION target_private.two_player_turn_clock();

CREATE FUNCTION target_private.two_player_advance_turn(p_member uuid DEFAULT NULL,p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE m record; now_value timestamptz:=clock_timestamp(); passes bigint; next_deadline timestamptz; changed integer:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  FOR m IN SELECT r.* FROM target_private.two_player_matches r JOIN (
      SELECT a.match_id AS id FROM target_private.two_player_participants a WHERE a.member_id=p_member
      UNION SELECT g.id FROM target_private.two_player_matches g WHERE p_member IS NULL AND g.status='playing' AND g.turn_expires_at<=now_value
    ) selected ON selected.id=r.id
    WHERE r.status='playing' AND r.turn_expires_at<=now_value AND r.expires_at>now_value AND
      NOT EXISTS(SELECT 1 FROM target_private.two_player_moves x WHERE x.match_id=r.id AND x.round=r.round AND x.resolved_at IS NULL)
    ORDER BY r.turn_expires_at LIMIT least(greatest(p_limit,1),100) FOR UPDATE OF r LOOP
    passes:=floor(extract(epoch FROM (now_value-m.turn_expires_at))/60)::bigint+1;
    IF m.round::bigint+passes>2147483647 THEN CONTINUE; END IF;
    next_deadline:=m.turn_expires_at+passes*interval '60 seconds';
    UPDATE target_private.two_player_matches SET round=(round::bigint+passes)::integer,
      turn=CASE WHEN passes%2=0 THEN turn WHEN turn='host' THEN 'guest' ELSE 'host' END,
      turn_started_at=next_deadline-interval '60 seconds',turn_expires_at=next_deadline,
      state=target_private.two_player_clear_goal_areas(state) WHERE id=m.id;
    -- A passive timeout is not human activity. In particular, expires_at is
    -- unchanged so an unattended funded match still refunds after ten minutes.
    changed:=changed+1;
  END LOOP;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION target_private.two_player_advance_turn(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION target_private.two_player_turn_replace(p_source text,p_old text,p_new text,p_count integer DEFAULT 1)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF (length(p_source)-length(replace(p_source,p_old,'')))/length(p_old)<>p_count THEN
    RAISE EXCEPTION 'Reviewed turn adaptation marker mismatch: %',left(p_old,100); END IF;
  RETURN replace(p_source,p_old,p_new);
END $$;
DO $adapt$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('target_private.two_player_initial_state(integer,integer)'::regprocedure) INTO definition;
  definition:=target_private.two_player_turn_replace(definition,',0,320,900)',',0,320,846)',3);
  EXECUTE definition;

  SELECT pg_get_functiondef('target_private.two_player_match_dto(uuid,boolean)'::regprocedure) INTO definition;
  definition:=target_private.two_player_turn_replace(definition,'''turn'',m.turn,''state'',m.state,',
    '''turn'',m.turn,''state'',m.state,''turnStartedAt'',m.turn_started_at,''turnExpiresAt'',m.turn_expires_at,''serverNow'',clock_timestamp(),');
  EXECUTE definition;

  SELECT pg_get_functiondef('target_private.two_player_expire(uuid,integer)'::regprocedure) INTO definition;
  definition:=target_private.two_player_turn_replace(definition,'  RETURN count_value;',
    '  IF p_member IS NOT NULL THEN PERFORM target_private.two_player_advance_turn(p_member,p_limit); END IF;'||chr(10)||'  RETURN count_value;');
  EXECUTE definition;

  SELECT pg_get_functiondef('target_private.two_player_move_version()'::regprocedure) INTO definition;
  definition:=target_private.two_player_turn_replace(definition,'  RETURN NEW;',
    '  IF m.turn_started_at>clock_timestamp() OR m.turn_expires_at<=clock_timestamp() THEN'||chr(10)||
    '    RAISE EXCEPTION ''Soccer turn deadline is stale'' USING ERRCODE=''P7502''; END IF;'||chr(10)||
    '  NEW.turn_rules:=true;'||chr(10)||'  RETURN NEW;');
  EXECUTE definition;

  SELECT pg_get_functiondef('public.two_player_rpc(text,text,jsonb)'::regprocedure) INTO definition;
  definition:=target_private.two_player_turn_replace(definition,'''^[0-9]{1,2}$''','''^[0-9]{1,10}$''');
  definition:=target_private.two_player_turn_replace(definition,
    '    round_value:=(p_input->>''round'')::integer;',
    '    IF (p_input->>''round'')::numeric>2147483647 THEN'||chr(10)||
    '      RETURN target_private.error_result(400,''INVALID_REQUEST'',''手番を読み直してください。''); END IF;'||chr(10)||
    '    round_value:=(p_input->>''round'')::integer;');
  definition:=target_private.two_player_turn_replace(definition,'round_value NOT BETWEEN 1 AND 40','round_value<1');
  definition:=target_private.two_player_turn_replace(definition,
    '      IF side<>m.turn THEN RETURN target_private.error_result(409,''NOT_YOUR_TURN'',''相手の手番です。''); END IF;',
    '      IF side<>m.turn THEN RETURN target_private.error_result(409,''NOT_YOUR_TURN'',''相手の手番です。''); END IF;'||chr(10)||
    '      IF m.turn_started_at>clock_timestamp() THEN RETURN target_private.error_result(409,''TURN_PENDING'',''前の動きが終わるまでお待ちください。''); END IF;');
  definition:=target_private.two_player_turn_replace(definition,
    '        ELSIF m.round=40 THEN'||chr(10)||
    '          PERFORM target_private.two_player_settle(m.id,''finished'',''draw'',''forty_moves'');'||chr(10),'');
  definition:=target_private.two_player_turn_replace(definition,
    '  IF p_action NOT IN (''resolve'',''cancel'') AND (SELECT count(*) FROM target_private.two_player_requests WHERE match_id=m.id AND member_id=member_uuid)>=256 THEN'||chr(10)||
    '    RAISE EXCEPTION ''Soccer request capacity exceeded'' USING ERRCODE=''54000''; END IF;'||chr(10),'');
  definition:=target_private.two_player_turn_replace(definition,
    '      result_value:=jsonb_build_object(''goal'',p_input->''goal'',''state'',p_input->''state'',''frames'',p_input->''frames'');',
    '      IF x.match_id IS NOT NULL AND (x.resolved_at IS NULL OR x.turn_rules) THEN'||chr(10)||
    '        p_input:=jsonb_set(p_input,''{state}'',CASE WHEN goal_value IS NULL THEN target_private.two_player_clear_goal_areas(p_input->''state'')'||chr(10)||
    '          ELSE target_private.two_player_initial_state(m.host_formation,m.guest_formation) END);'||chr(10)||
    '        IF goal_value IS NULL AND jsonb_array_length(p_input->''frames'')>0 THEN'||chr(10)||
    '          p_input:=jsonb_set(p_input,ARRAY[''frames'',(jsonb_array_length(p_input->''frames'')-1)::text],p_input->''state''); END IF;'||chr(10)||
    '      END IF;'||chr(10)||
    '      result_value:=jsonb_build_object(''goal'',p_input->''goal'',''state'',p_input->''state'',''frames'',p_input->''frames'');');
  definition:=target_private.two_player_turn_replace(definition,
    'UPDATE target_private.two_player_moves SET result_hash=result_hash_value,goal=goal_value,frames=p_input->''frames'',state=p_input->''state'',',
    'UPDATE target_private.two_player_moves SET result_hash=result_hash_value,goal=goal_value,frames=p_input->''frames'',state=p_input->''state'',turn_rules=true,');
  definition:=target_private.two_player_turn_replace(definition,
    'EXCEPTION WHEN SQLSTATE ''54000'' THEN',
    'EXCEPTION WHEN SQLSTATE ''P7502'' THEN'||chr(10)||
    '  RETURN target_private.error_result(409,''STALE_INPUT'',''手番が進みました。画面を読み直してください。'');'||chr(10)||
    'WHEN SQLSTATE ''54000'' THEN');
  EXECUTE definition;
END $adapt$;
DROP FUNCTION target_private.two_player_turn_replace(text,text,text,integer);

-- Active games retain escrow, scores and permanent receipts. Their first clock
-- starts at cutover; a previously accepted input remains leased and recoverable.
WITH cutover AS MATERIALIZED(SELECT clock_timestamp() AS started)
UPDATE target_private.two_player_matches SET
  turn_started_at=cutover.started,turn_expires_at=cutover.started+interval '60 seconds',
  state=CASE WHEN EXISTS(SELECT 1 FROM target_private.two_player_moves x
    WHERE x.match_id=two_player_matches.id AND x.round=two_player_matches.round AND x.resolved_at IS NULL)
    THEN state ELSE target_private.two_player_clear_goal_areas(state) END
  FROM cutover WHERE status='playing';
ALTER TABLE target_private.two_player_matches VALIDATE CONSTRAINT two_player_turn_clock_check;
COMMENT ON FUNCTION target_private.two_player_advance_turn(uuid,integer) IS
  'Atomically advance expired 60s turns without treating timeouts as activity or changing money.';
COMMIT;
