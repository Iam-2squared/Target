-- Authorized one-time challenge progress reset. Previously paid money stays paid.
-- Levels1-5 attack every3000ms; levels6-10 use2800/2600/2400/2200/2000ms.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
DO $pace$
DECLARE item record; signature text; definition text; marker text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','f420287f88c5e5f598c9e679f711b90c'),
  ('target_private.challenge_dto(uuid,uuid)','60bf3c79589f69523fda3939d0e381be'),
  ('target_private.challenge_tick(uuid,timestamptz)','88458e872af0fd28593b35511ec9099a'),
  ('target_private.challenge_storage_charge()','71d4ba2553f5ef56ca0ebc65063f42d9')
 ) expected(signature,digest) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.digest THEN
   RAISE EXCEPTION 'Reviewed pre-reset challenge definition changed: %',item.signature; END IF;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['target_private.challenge_dto(uuid,uuid)',
  'target_private.challenge_tick(uuid,timestamptz)','public.target_challenge_rpc(text,text,jsonb)'] LOOP
  SELECT pg_get_functiondef(to_regprocedure(signature)) INTO definition;
  IF signature='target_private.challenge_dto(uuid,uuid)' THEN
   marker:='''attackIntervalMs'',3000,';
   IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
    RAISE EXCEPTION 'Challenge DTO pace marker changed'; END IF;
   definition:=replace(definition,marker,'''attackIntervalMs'',CASE WHEN r.level>=6 THEN 3000-200*(r.level-5) ELSE 3000 END,');
  ELSIF signature='target_private.challenge_tick(uuid,timestamptz)' THEN
   marker:='pace:=3000;';
   IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
    RAISE EXCEPTION 'Challenge attack pace marker changed'; END IF;
   definition:=replace(definition,marker,'pace:=CASE WHEN r.level>=6 THEN 3000-200*(r.level-5) ELSE 3000 END;');
  ELSE
   FOR item IN SELECT * FROM (VALUES
    ('''attackIntervalMs'',3000,','''attackIntervalMs'',CASE WHEN l>=6 THEN 3000-200*(l-5) ELSE 3000 END,'),
    ('pace:=3000;'||chr(10)||'  INSERT INTO target_private.challenge_runs(member_id,level,player_hp,enemy_hp,attack_remaining_ms)',
     'pace:=CASE WHEN chosen_level>=6 THEN 3000-200*(chosen_level-5) ELSE 3000 END;'||chr(10)||'  INSERT INTO target_private.challenge_runs(member_id,level,player_hp,enemy_hp,attack_remaining_ms)'),
    ('pace:=3000;'||chr(10)||' END IF;',
     'pace:=CASE WHEN r.level>=6 THEN 3000-200*(r.level-5) ELSE 3000 END;'||chr(10)||' END IF;')
   ) patches(old_text,new_text) LOOP
    marker:=item.old_text;
    IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
     RAISE EXCEPTION 'Challenge RPC pace marker changed: %',marker; END IF;
    definition:=replace(definition,marker,item.new_text);
   END LOOP;
  END IF;
  EXECUTE definition;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','6bcffc66c8f4cf01aab57219ff140aae'),
  ('target_private.challenge_dto(uuid,uuid)','d0fdbe59478a7ebc3b479dc854090e29'),
  ('target_private.challenge_tick(uuid,timestamptz)','a81f2b827c4146ada04e2240a49cfc52')
 ) expected(signature,digest) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.digest THEN
   RAISE EXCEPTION 'Unexpected post-reset challenge definition: %',item.signature; END IF;
 END LOOP;
END; $pace$;

DO $reset$
DECLARE
 profiles_before text; rewards_before text; requests_before text; terminal_before text;
 projection_before text; finance_before text; active_progress_before text;
 active_ids uuid[]; badge_count bigint; removed bigint; old_budget bigint; new_budget bigint;
 badge_bytes bigint; active_bytes_before bigint; active_bytes_after bigint;
 cutover timestamptz:=clock_timestamp();
BEGIN
 -- Disable only the named BEFORE immutable guard. The AFTER storage trigger
 -- remains enabled throughout, including every deleted badge and aborted run.
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.challenge_badges'::regclass
  AND tgname='challenge_badges_immutable' AND NOT tgisinternal AND tgenabled='O' AND tgtype=27
  AND tgfoid='target_private.battle_immutable()'::regprocedure) OR
  NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.challenge_badges'::regclass
  AND tgname='challenge_badges_storage' AND NOT tgisinternal AND tgenabled='O' AND tgtype=29
  AND tgfoid='target_private.challenge_storage_charge()'::regprocedure) THEN
  RAISE EXCEPTION 'Reviewed challenge badge protection/accounting changed'; END IF;
 SELECT md5(coalesce(string_agg(to_jsonb(p)::text,'' ORDER BY member_id),'')) INTO profiles_before FROM target_private.profiles p;
 SELECT md5(coalesce(string_agg(to_jsonb(e)::text,'' ORDER BY run_id),'')) INTO rewards_before FROM target_private.challenge_reward_events e;
 SELECT md5(coalesce(string_agg(to_jsonb(q)::text,'' ORDER BY member_id,request_id),'')) INTO requests_before FROM target_private.challenge_requests q;
 SELECT md5(coalesce(string_agg(to_jsonb(f)::text,'' ORDER BY member_id),'')) INTO projection_before FROM target_private.wallet_finance_projection(NULL) f;
 SELECT md5(prosrc) INTO finance_before FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure;
 IF finance_before IS NULL THEN RAISE EXCEPTION 'Shared financial projection missing'; END IF;
 SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO active_ids FROM target_private.challenge_runs WHERE status IN ('playing','paused');
 SELECT md5(coalesce(string_agg(to_jsonb(r)::text,'' ORDER BY id),'')) INTO terminal_before
  FROM target_private.challenge_runs r WHERE NOT(id=ANY(active_ids));
 SELECT md5(coalesce(string_agg((to_jsonb(r)-ARRAY['status','questions','next_attack_at','updated_at'])::text,'' ORDER BY id),'')),
  coalesce(sum(pg_column_size(to_jsonb(r))+128),0) INTO active_progress_before,active_bytes_before
  FROM target_private.challenge_runs r WHERE id=ANY(active_ids);
 SELECT count(*),coalesce(sum(pg_column_size(to_jsonb(b))+128),0) INTO badge_count,badge_bytes FROM target_private.challenge_badges b;
 SELECT logical_bytes INTO old_budget FROM target_private.system_state WHERE singleton FOR UPDATE;
 UPDATE target_private.challenge_runs SET status='aborted',questions='[]'::jsonb,next_attack_at=NULL,updated_at=cutover
  WHERE id=ANY(active_ids);
 ALTER TABLE target_private.challenge_badges DISABLE TRIGGER challenge_badges_immutable;
 DELETE FROM target_private.challenge_badges;
 GET DIAGNOSTICS removed=ROW_COUNT;
 ALTER TABLE target_private.challenge_badges ENABLE TRIGGER challenge_badges_immutable;
 IF removed<>badge_count OR EXISTS(SELECT 1 FROM target_private.challenge_badges) OR
  EXISTS(SELECT 1 FROM target_private.challenge_runs WHERE status IN ('playing','paused')) OR
  NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.challenge_badges'::regclass
   AND tgname='challenge_badges_immutable' AND tgenabled='O') OR
  NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.challenge_badges'::regclass
   AND tgname='challenge_badges_storage' AND tgenabled='O') THEN
  RAISE EXCEPTION 'Challenge reset or badge protection restoration incomplete'; END IF;
 IF profiles_before IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(p)::text,'' ORDER BY member_id),'')) FROM target_private.profiles p) OR
  rewards_before IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(e)::text,'' ORDER BY run_id),'')) FROM target_private.challenge_reward_events e) OR
  requests_before IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(q)::text,'' ORDER BY member_id,request_id),'')) FROM target_private.challenge_requests q) OR
  projection_before IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(f)::text,'' ORDER BY member_id),'')) FROM target_private.wallet_finance_projection(NULL) f) OR
  finance_before IS DISTINCT FROM (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure) THEN
  RAISE EXCEPTION 'Challenge reset changed existing money, financial history, receipts or projection'; END IF;
 IF terminal_before IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(r)::text,'' ORDER BY id),''))
   FROM target_private.challenge_runs r WHERE NOT(id=ANY(active_ids))) OR
  active_progress_before IS DISTINCT FROM (SELECT md5(coalesce(string_agg((to_jsonb(r)-ARRAY['status','questions','next_attack_at','updated_at'])::text,'' ORDER BY id),''))
   FROM target_private.challenge_runs r WHERE id=ANY(active_ids)) OR
  EXISTS(SELECT 1 FROM target_private.challenge_runs WHERE id=ANY(active_ids)
   AND (status<>'aborted' OR questions<>'[]'::jsonb OR next_attack_at IS NOT NULL OR updated_at<>cutover)) THEN
  RAISE EXCEPTION 'Challenge reset changed historical or preserved active progress fields'; END IF;
 SELECT coalesce(sum(pg_column_size(to_jsonb(r))+128),0) INTO active_bytes_after
  FROM target_private.challenge_runs r WHERE id=ANY(active_ids);
 SELECT logical_bytes INTO new_budget FROM target_private.system_state WHERE singleton;
 IF new_budget IS DISTINCT FROM old_budget+active_bytes_after-active_bytes_before-badge_bytes THEN
  RAISE EXCEPTION 'Challenge reset storage quota does not reconcile'; END IF;
END; $reset$;
COMMIT;
