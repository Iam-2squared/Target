-- Pay at most three clears per member and level, counting all historical payouts.
-- Later clears still win, earn eligible badges and unlock levels. Old money stays paid.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
DO $guard$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure)
  IS DISTINCT FROM '6bcffc66c8f4cf01aab57219ff140aae' OR
  (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.challenge_dto(uuid,uuid)'::regprocedure)
  IS DISTINCT FROM 'd0fdbe59478a7ebc3b479dc854090e29' THEN
  RAISE EXCEPTION 'Reviewed challenge definitions changed before lifetime reward cap'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.challenge_runs'::regclass
  AND conname='challenge_runs_check3' AND pg_get_constraintdef(oid)=
  'CHECK (((status <> ''won''::text) OR ((enemy_hp = 0) AND (reward = (level * 100000)))))') THEN
  RAISE EXCEPTION 'Reviewed won-run reward constraint changed'; END IF;
END; $guard$;
ALTER TABLE target_private.challenge_runs DROP CONSTRAINT challenge_runs_check3;
ALTER TABLE target_private.challenge_runs ADD CONSTRAINT challenge_runs_check3
 CHECK(status<>'won' OR (enemy_hp=0 AND reward IN (0,level*100000)));
DO $cap$
DECLARE definition text; marker text; item record; finance_before text;
BEGIN
 SELECT md5(prosrc) INTO finance_before FROM pg_proc
  WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure;
 IF finance_before IS NULL THEN RAISE EXCEPTION 'Shared financial projection missing'; END IF;
 SELECT pg_get_functiondef('target_private.challenge_dto(uuid,uuid)'::regprocedure) INTO definition;
 FOR item IN SELECT * FROM (VALUES
  ('''reward'',r.reward,''badgeAwarded'',r.badge_awarded,',
   '''reward'',r.reward,''badgeAwarded'',r.badge_awarded,'||chr(10)||
   ' ''rewardLimit'',3,''rewardedClears'',payments.paid_count,''rewardsRemaining'',greatest(0,3-payments.paid_count),'),
  ('FROM target_private.challenge_runs r WHERE r.id=p_run AND r.member_id=p_member;',
   'FROM target_private.challenge_runs r CROSS JOIN LATERAL ('||chr(10)||
   '  SELECT count(*)::integer AS paid_count FROM target_private.challenge_reward_events e'||chr(10)||
   '  WHERE e.member_id=r.member_id AND e.level=r.level AND e.amount>0'||chr(10)||
   ' ) payments WHERE r.id=p_run AND r.member_id=p_member;')
 ) patches(old_text,new_text) LOOP
  marker:=item.old_text;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
   RAISE EXCEPTION 'Reward-cap DTO marker changed: %',marker; END IF;
  definition:=replace(definition,marker,item.new_text);
 END LOOP;
 EXECUTE definition;
 SELECT pg_get_functiondef('public.target_challenge_rpc(text,text,jsonb)'::regprocedure) INTO definition;
 FOR item IN SELECT * FROM (VALUES
  ('max_income bigint:=10000000000000; pending_payout bigint;',
   'max_income bigint:=10000000000000; pending_payout bigint; paid_count integer; payout bigint:=0; did_clear boolean:=false;'),
  ('''reward'',l*100000,',
   '''reward'',CASE WHEN coalesce(payments.paid_count,0)<3 THEN l*100000 ELSE 0 END,'||chr(10)||
   '    ''rewardLimit'',3,''rewardedClears'',coalesce(payments.paid_count,0),''rewardsRemaining'',greatest(0,3-coalesce(payments.paid_count,0)),'),
  ('FROM generate_series(1,10) l)',
   'FROM generate_series(1,10) l LEFT JOIN ('||chr(10)||
   '    SELECT e.level,count(*)::integer AS paid_count FROM target_private.challenge_reward_events e'||chr(10)||
   '    WHERE e.member_id=actor AND e.amount>0 GROUP BY e.level'||chr(10)||
   '   ) payments ON payments.level=l)'),
  ('IF r.enemy_hp=0 THEN'||chr(10)||'   SELECT * INTO p FROM target_private.profiles WHERE member_id=actor FOR UPDATE;',
   'IF r.enemy_hp=0 THEN'||chr(10)||
   '   did_clear:=true;'||chr(10)||
   '   SELECT count(*)::integer INTO paid_count FROM target_private.challenge_reward_events'||chr(10)||
   '    WHERE member_id=actor AND level=r.level AND amount>0;'||chr(10)||
   '   payout:=CASE WHEN paid_count<3 THEN r.level*100000 ELSE 0 END;'||chr(10)||
   '   IF payout>0 THEN'||chr(10)||
   '   SELECT * INTO p FROM target_private.profiles WHERE member_id=actor FOR UPDATE;'),
  ('casino_net=casino_net+r.level*100000,updated_at=now_at WHERE member_id=actor;'||chr(10)||
   '   INSERT INTO target_private.challenge_badges(member_id,level,run_id)',
   'casino_net=casino_net+r.level*100000,updated_at=now_at WHERE member_id=actor;'||chr(10)||
   '   END IF;'||chr(10)||
   '   INSERT INTO target_private.challenge_badges(member_id,level,run_id)'),
  ('awarded:=FOUND;r.status:=''won'';r.reward:=r.level*100000;r.badge_awarded:=awarded;',
   'awarded:=FOUND;r.status:=''won'';r.reward:=payout;r.badge_awarded:=awarded;'),
  ('IF awarded OR r.reward>0 THEN output:=output||jsonb_build_object(''reward'',r.reward,''badgeAwarded'',r.badge_awarded); END IF;',
   'IF awarded OR r.reward>0 THEN output:=output||jsonb_build_object(''reward'',r.reward,''badgeAwarded'',r.badge_awarded); END IF;'||chr(10)||
   ' IF did_clear THEN output:=output||jsonb_build_object(''cleared'',true,''reward'',r.reward,''badgeAwarded'',r.badge_awarded); END IF;')
 ) patches(old_text,new_text) LOOP
  marker:=item.old_text;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
   RAISE EXCEPTION 'Lifetime reward-cap RPC marker changed: %',marker; END IF;
  definition:=replace(definition,marker,item.new_text);
 END LOOP;
 EXECUTE definition;
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','389b08b44def976556235f3efaff5c52'),
  ('target_private.challenge_dto(uuid,uuid)','331e412e43afba33ef27123bcded9bce')
 ) expected(signature,digest) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.digest THEN
   RAISE EXCEPTION 'Unexpected lifetime reward-cap definition: %',item.signature; END IF;
 END LOOP;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
  IS DISTINCT FROM finance_before THEN
  RAISE EXCEPTION 'Lifetime reward cap changed shared financial projection'; END IF;
END; $cap$;
COMMIT;
