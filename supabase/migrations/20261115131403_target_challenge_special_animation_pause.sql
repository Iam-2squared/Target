-- Confirmed nonwinning specials pause combat atomically for fullscreen animation.
-- Guarded automatic resume reuses immutable answer receipts; no columns or row migration.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
DO $patch$
DECLARE definition text; item record; finance_before text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure)
  IS DISTINCT FROM '5dbf345b4430b6e8a5023cb94586e844' THEN
  RAISE EXCEPTION 'Reviewed growing challenge RPC changed before special pause'; END IF;
 SELECT md5(prosrc) INTO finance_before FROM pg_proc
  WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure;
 IF finance_before IS NULL THEN RAISE EXCEPTION 'Shared financial projection missing'; END IF;
 SELECT pg_get_functiondef('public.target_challenge_rpc(text,text,jsonb)'::regprocedure) INTO definition;
 FOR item IN SELECT * FROM (VALUES
  ('special boolean:=false; special_damage integer:=0; special_power integer:=0; special_percent integer:=0;',
   'special boolean:=false; special_damage integer:=0; special_power integer:=0; special_percent integer:=0;'||chr(10)||
   ' special_paused boolean:=false; special_pause_at timestamptz; special_origin target_private.challenge_requests%rowtype;'),
  ('ELSIF p_action<>''map'' THEN keys:=keys||ARRAY[''requestId'',''runId'']; END IF;',
   'ELSIF p_action<>''map'' THEN keys:=keys||ARRAY[''requestId'',''runId'']; END IF;'||chr(10)||
   ' IF p_action=''resume'' AND p_input?''specialRequestId'' THEN keys:=keys||ARRAY[''specialRequestId'']; END IF;'||chr(10)||
   ' IF p_action=''resume'' AND p_input?''specialRequestId'' AND'||chr(10)||
   '  coalesce(p_input->>''specialRequestId'','''')!~''^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'' THEN'||chr(10)||
   '  RETURN target_private.error_result(400,''INVALID_CHALLENGE_REQUEST'',''送信内容を確認してください。''); END IF;'),
  ('IF p_action=''pause'' AND r.status=''playing'' THEN',
   'IF p_action=''resume'' AND p_input?''specialRequestId'' THEN'||chr(10)||
   '  SELECT * INTO special_origin FROM target_private.challenge_requests'||chr(10)||
   '   WHERE member_id=actor AND request_id=(p_input->>''specialRequestId'')::uuid;'||chr(10)||
   '  IF r.status IS DISTINCT FROM ''paused'' OR special_origin.request_id IS NULL OR'||chr(10)||
   '   special_origin.action IS DISTINCT FROM ''answer'' OR special_origin.run_id IS DISTINCT FROM r.id OR'||chr(10)||
   '   special_origin.response#>>''{answer,specialPaused}'' IS DISTINCT FROM ''true'' OR'||chr(10)||
   '   (special_origin.response#>>''{answer,specialPausedAt}'')::timestamptz IS DISTINCT FROM r.updated_at THEN'||chr(10)||
   '   RETURN target_private.error_result(409,''CHALLENGE_SPECIAL_CHANGED'',''一時停止の状態が変わりました。状態を確認してください。''); END IF;'||chr(10)||
   ' END IF;'||chr(10)||
   ' IF p_action=''pause'' AND r.status IN (''playing'',''paused'') THEN'),
  ('ELSE r.sequence:=r.sequence+1; END IF;'||chr(10)||
   '  UPDATE target_private.challenge_runs SET player_hp=r.player_hp,enemy_hp=r.enemy_hp,streak=r.streak,',
   'ELSE r.sequence:=r.sequence+1; END IF;'||chr(10)||
   '  IF special AND r.status=''playing'' THEN'||chr(10)||
   '   IF r.next_attack_at IS NOT NULL THEN'||chr(10)||
   '    r.attack_remaining_ms:=least(3000,greatest(0,ceil(extract(epoch FROM (r.next_attack_at-now_at))*1000)::integer));'||chr(10)||
   '   END IF;'||chr(10)||
   '   r.status:=''paused'';r.next_attack_at:=NULL;special_paused:=true;special_pause_at:=now_at;'||chr(10)||
   '  END IF;'||chr(10)||
   '  UPDATE target_private.challenge_runs SET player_hp=r.player_hp,enemy_hp=r.enemy_hp,streak=r.streak,'),
  ('''specialPower'',special_power,''specialPercent'',special_percent);',
   '''specialPower'',special_power,''specialPercent'',special_percent,'||chr(10)||
   '   ''specialPaused'',special_paused,''specialPausedAt'',special_pause_at);')
 ) patches(old_text,new_text) LOOP
  IF (length(definition)-length(replace(definition,item.old_text,'')))/length(item.old_text)<>1 THEN
   RAISE EXCEPTION 'Challenge special-pause patch marker changed: %',item.old_text; END IF;
  definition:=replace(definition,item.old_text,item.new_text);
 END LOOP;
 EXECUTE definition;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure)
  IS DISTINCT FROM 'b74f38f7d92fc6839eeaf854292f4f12' THEN
  RAISE EXCEPTION 'Unexpected special-animation pause RPC definition'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
  IS DISTINCT FROM finance_before THEN
  RAISE EXCEPTION 'Special animation pause changed shared financial projection'; END IF;
END; $patch$;
COMMIT;
