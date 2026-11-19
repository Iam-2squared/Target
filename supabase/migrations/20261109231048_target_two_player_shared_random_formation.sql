-- Server chooses one of the three existing layouts once per new match.
-- Both seats use that layout, mirrored. Existing matches and ledger rows stay intact.
BEGIN;
SELECT pg_advisory_xact_lock(991101);

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.two_player_rpc(text,text,jsonb)'::regprocedure)
      IS DISTINCT FROM 'b7a4c7594a8191dce5b6f677773616df' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer)'::regprocedure)
      IS DISTINCT FROM '0cfde56d59e222f2fc2d036a0e5439f5' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.two_player_initial_state(integer,integer)'::regprocedure)
      IS DISTINCT FROM '2358e90576964049d2979b1c7d1b81d5' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
      IS DISTINCT FROM '8e69577732c1f54b2dae637b87aa3fd6' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_games_rpc(text,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '71ddbc56e79a79dcd8a046d556b73a59' THEN
    RAISE EXCEPTION 'Reviewed soccer, matchmaking or financial boundary changed';
  END IF;
END $guard$;

-- The table boundary also covers an already compiled, pre-cutover create or
-- formation call waiting on the global lock. Funding and goal resets reuse the
-- stored columns; neither operation is allowed to choose another layout.
CREATE FUNCTION target_private.two_player_shared_formation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE chosen integer;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.version=2 THEN
      chosen:=floor(random()*3)::integer;
      NEW.host_formation:=chosen;
      NEW.guest_formation:=chosen;
      NEW.state:=target_private.two_player_initial_state(chosen,chosen);
    END IF;
  ELSIF NEW.host_formation IS DISTINCT FROM OLD.host_formation OR
      NEW.guest_formation IS DISTINCT FROM OLD.guest_formation THEN
    RAISE EXCEPTION 'Soccer formation is fixed for the match' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION target_private.two_player_shared_formation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER two_player_shared_formation BEFORE INSERT OR UPDATE ON target_private.two_player_matches
  FOR EACH ROW EXECUTE FUNCTION target_private.two_player_shared_formation();

-- Only the obsolete formation action changes in the soccer RPC. In particular,
-- escrow, settlement, expiry and receipt branches are byte-for-byte preserved.
DO $adapt$
DECLARE definition text; old_value text; new_value text;
BEGIN
  SELECT pg_get_functiondef('public.two_player_rpc(text,text,jsonb)'::regprocedure) INTO definition;
  old_value:='  IF p_action IS NULL OR p_action NOT IN ';
  new_value:='  IF p_action=''formation'' THEN'||chr(10)||
    '    RETURN target_private.error_result(409,''FORMATION_FIXED'',''陣形は対戦ごとに自動で決まります。'');'||chr(10)||
    '  END IF;'||chr(10)||old_value;
  IF (length(definition)-length(replace(definition,old_value,'')))/length(old_value)<>1 THEN
    RAISE EXCEPTION 'Reviewed soccer formation rejection marker changed'; END IF;
  EXECUTE replace(definition,old_value,new_value);

  SELECT pg_get_functiondef('target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer)'::regprocedure) INTO definition;
  -- Retain the private signature and validated public payload for compatibility
  -- with open clients. Caller formation fields no longer influence either seat.
  old_value:=$old$  IF host_formation<>0 THEN
    result:=public.two_player_rpc(p_secret,'formation',jsonb_build_object('memberId',host_id,'name',host_name,
      'requestId',gen_random_uuid(),'matchId',match_id,'formation',host_formation));
    IF result?'error' THEN RAISE EXCEPTION 'Lobby host formation failed' USING ERRCODE='P7501',DETAIL=result::text; END IF;
  END IF;
  IF guest_formation<>0 THEN
    result:=public.two_player_rpc(p_secret,'formation',jsonb_build_object('memberId',guest_id,'name',guest_name,
      'requestId',gen_random_uuid(),'matchId',match_id,'formation',guest_formation));
    IF result?'error' THEN RAISE EXCEPTION 'Lobby guest formation failed' USING ERRCODE='P7501',DETAIL=result::text; END IF;
  END IF;
$old$;
  IF (length(definition)-length(replace(definition,old_value,'')))/length(old_value)<>1 THEN
    RAISE EXCEPTION 'Reviewed lobby formation assignment marker changed'; END IF;
  EXECUTE replace(definition,old_value,'');
END $adapt$;

COMMENT ON FUNCTION target_private.two_player_shared_formation() IS
  'Choose one common random V2 formation at INSERT; preserve it for every ready, shot and goal reset.';
COMMENT ON FUNCTION public.two_player_rpc(text,text,jsonb) IS
  'Dedicated-credential alternating soccer V2; server-selected shared random formation, unchanged wallet escrow and settlement.';
COMMIT;
