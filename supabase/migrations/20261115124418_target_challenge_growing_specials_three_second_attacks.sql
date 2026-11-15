-- Specials grow with each ten-answer milestone; every enemy attacks every 3 seconds.
-- Historical answer/reward receipts, HP, streaks, questions and shared finance stay intact.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
DO $patch$
DECLARE item record; signature text; definition text; marker text; finance_before text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','55c8efdd3b70cd967de68842f4b55871'),
  ('target_private.challenge_dto(uuid,uuid)','09df7117fccb6b94451c193a607d549d'),
  ('target_private.challenge_tick(uuid,timestamptz)','dcc07c2a0175268b2daa49618a7eaaa8')
 ) expected(signature,digest) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.digest THEN
   RAISE EXCEPTION 'Reviewed challenge definition changed: %',item.signature; END IF;
 END LOOP;
 SELECT md5(prosrc) INTO finance_before FROM pg_proc
  WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure;
 IF finance_before IS NULL THEN RAISE EXCEPTION 'Shared financial projection missing'; END IF;
 FOREACH signature IN ARRAY ARRAY['target_private.challenge_dto(uuid,uuid)',
  'target_private.challenge_tick(uuid,timestamptz)','public.target_challenge_rpc(text,text,jsonb)'] LOOP
  SELECT pg_get_functiondef(to_regprocedure(signature)) INTO definition;
  marker:='CASE WHEN r.level=10 THEN 2000 ELSE 3000-100*(r.level-1) END';
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
   RAISE EXCEPTION 'Challenge three-second clock marker changed: %',signature; END IF;
  definition:=replace(definition,marker,'3000');
  IF signature='public.target_challenge_rpc(text,text,jsonb)' THEN
   FOR item IN SELECT * FROM (VALUES
    ('CASE WHEN l=10 THEN 2000 ELSE 3000-100*(l-1) END','3000'),
    ('CASE WHEN chosen_level=10 THEN 2000 ELSE 3000-100*(chosen_level-1) END','3000'),
    ('special boolean:=false; special_damage integer:=0; special_power integer:=0;',
     'special boolean:=false; special_damage integer:=0; special_power integer:=0; special_percent integer:=0;'),
    ('special_power:=10*r.level;',
     'special_percent:=r.streak+1; special_power:=special_percent*r.level;'),
    ('''specialPower'',special_power);',
     '''specialPower'',special_power,''specialPercent'',special_percent);')
   ) patches(old_text,new_text) LOOP
    marker:=item.old_text;
    IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
     RAISE EXCEPTION 'Growing challenge special marker changed: %',marker; END IF;
    definition:=replace(definition,marker,item.new_text);
   END LOOP;
  END IF;
  EXECUTE definition;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','5dbf345b4430b6e8a5023cb94586e844'),
  ('target_private.challenge_dto(uuid,uuid)','f4f5f936f9d5b046b6d9baee36512532'),
  ('target_private.challenge_tick(uuid,timestamptz)','88458e872af0fd28593b35511ec9099a')
 ) expected(signature,digest) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.digest THEN
   RAISE EXCEPTION 'Unexpected growing challenge definition: %',item.signature; END IF;
 END LOOP;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
  IS DISTINCT FROM finance_before THEN
  RAISE EXCEPTION 'Growing challenge specials changed shared financial projection'; END IF;
END; $patch$;

-- Preserve time already spent in the current cycle. Extend its deadline (or
-- paused/pending-question remainder) only by the difference from the old pace.
-- No eager attack, updated_at change, question replacement, or progress reset.
DO $clock$
BEGIN
 IF EXISTS(SELECT 1 FROM target_private.challenge_runs WHERE status IN ('playing','paused') AND level>1
  AND next_attack_at IS NULL AND attack_remaining_ms>
   (CASE WHEN level=10 THEN 2000 ELSE 3000-100*(level-1) END)) THEN
  RAISE EXCEPTION 'Active challenge saved remainder exceeds reviewed old interval'; END IF;
 UPDATE target_private.challenge_runs SET
  next_attack_at=next_attack_at+(3000-(CASE WHEN level=10 THEN 2000 ELSE 3000-100*(level-1) END))*interval '1 millisecond',
  attack_remaining_ms=CASE WHEN next_attack_at IS NULL THEN
   attack_remaining_ms+3000-(CASE WHEN level=10 THEN 2000 ELSE 3000-100*(level-1) END)
   ELSE attack_remaining_ms END
 WHERE status IN ('playing','paused') AND level>1;
END; $clock$;
COMMIT;
