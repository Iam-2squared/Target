-- Every tenth consecutive correct challenge answer adds 10% of enemy maximum HP.
-- Existing runs, streaks, questions, receipts, balances and financial functions are untouched.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
DO $special$
DECLARE definition text; finance_before text; item record; occurrences integer;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure)
  IS DISTINCT FROM 'a74ec6ae0fbe54fe6345daaee051b0ea' THEN
  RAISE EXCEPTION 'Reviewed challenge RPC changed before ten-combo special'; END IF;
 SELECT md5(prosrc) INTO finance_before FROM pg_proc
  WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure;
 IF finance_before IS NULL THEN RAISE EXCEPTION 'Shared financial projection missing'; END IF;
 SELECT pg_get_functiondef('public.target_challenge_rpc(text,text,jsonb)'::regprocedure) INTO definition;
 FOR item IN SELECT * FROM (VALUES
  ('accepted boolean; bonus boolean:=false; awarded boolean:=false; damage integer;',
   'accepted boolean; bonus boolean:=false; awarded boolean:=false; damage integer;'||chr(10)||
   ' special boolean:=false; special_damage integer:=0; special_power integer:=0;'),
  ('damage:=5;bonus:=(r.streak+1)%5=0;',
   'damage:=5;bonus:=(r.streak+1)%5=0;special:=(r.streak+1)%10=0;'||chr(10)||
   '   IF special THEN'||chr(10)||
   '    special_power:=10*r.level;'||chr(10)||
   '    special_damage:=least(special_power,greatest(0,r.enemy_hp-5));'||chr(10)||
   '   END IF;'),
  ('r.enemy_hp:=greatest(0,r.enemy_hp-5);r.player_hp:=r.player_hp+heal;r.streak:=r.streak+1;r.correct_count:=r.correct_count+1;',
   'r.enemy_hp:=greatest(0,r.enemy_hp-5-special_damage);r.player_hp:=r.player_hp+heal;r.streak:=r.streak+1;r.correct_count:=r.correct_count+1;'),
  ('''enemyHealedHp'',enemy_heal,''streakBonus'',bonus);',
   '''enemyHealedHp'',enemy_heal,''streakBonus'',bonus,'||chr(10)||
   '   ''specialAttack'',special,''specialDamage'',special_damage,''specialPower'',special_power);')
 ) patches(old_text,new_text) LOOP
  occurrences:=(length(definition)-length(replace(definition,item.old_text,'')))/length(item.old_text);
  IF occurrences<>1 THEN RAISE EXCEPTION 'Ten-combo patch marker changed: %',item.old_text; END IF;
  definition:=replace(definition,item.old_text,item.new_text);
 END LOOP;
 EXECUTE definition;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure)
  IS DISTINCT FROM '55c8efdd3b70cd967de68842f4b55871' THEN
  RAISE EXCEPTION 'Unexpected ten-combo challenge RPC definition'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
  IS DISTINCT FROM finance_before THEN
  RAISE EXCEPTION 'Ten-combo special changed shared financial projection'; END IF;
END; $special$;
COMMIT;
