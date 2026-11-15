-- Slower challenge attacks and classical Japanese only in levels 7-10.
-- The original challenge migration, finance projection, rewards and badges stay intact.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
DO $guard$
DECLARE item record;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','40f9c42130bff6ea176973f5ba7d9c0e'),
  ('target_private.challenge_dto(uuid,uuid)','87e4cd04309f220801990b5161e4f48a'),
  ('target_private.challenge_tick(uuid,timestamptz)','ab5dd92b8d57974dca63d8ca65901eb4'),
  ('target_private.challenge_storage_charge()','69be621da1580b84ed1d793cc7f95737'),
  ('target_private.wallet_finance_projection(timestamptz)','eafe8da70cbd3912d5310c083bdc303f')
 ) expected(signature,digest) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.digest THEN
   RAISE EXCEPTION 'Reviewed challenge definition changed: %',item.signature; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.challenge_runs'::regclass
  AND conname='challenge_runs_attack_remaining_ms_check'
  AND pg_get_constraintdef(oid)='CHECK (((attack_remaining_ms >= 0) AND (attack_remaining_ms <= 2000)))') THEN
  RAISE EXCEPTION 'Reviewed challenge remaining-clock constraint changed'; END IF;
END; $guard$;
ALTER TABLE target_private.challenge_runs DROP CONSTRAINT challenge_runs_attack_remaining_ms_check;
ALTER TABLE target_private.challenge_runs ADD CONSTRAINT challenge_runs_attack_remaining_ms_check
 CHECK(attack_remaining_ms BETWEEN 0 AND 3000);
ALTER TABLE target_private.challenge_runs ALTER COLUMN attack_remaining_ms SET DEFAULT 3000;

-- Replace only reviewed challenge function text. Matching counts fail closed;
-- permissions, search_path, correctness keys and all financial code are preserved.
DO $patch$
DECLARE signature text; definition text; marker text; replacement text; item record;
BEGIN
 FOREACH signature IN ARRAY ARRAY['target_private.challenge_dto(uuid,uuid)',
  'target_private.challenge_tick(uuid,timestamptz)','public.target_challenge_rpc(text,text,jsonb)'] LOOP
  SELECT pg_get_functiondef(to_regprocedure(signature)) INTO definition;
  marker:='CASE WHEN r.level=10 THEN 1000 ELSE 2000-100*(r.level-1) END';
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
   RAISE EXCEPTION 'Challenge clock patch marker changed: %',signature; END IF;
  definition:=replace(definition,marker,'CASE WHEN r.level=10 THEN 2000 ELSE 3000-100*(r.level-1) END');
  IF signature='public.target_challenge_rpc(text,text,jsonb)' THEN
   FOR item IN SELECT * FROM (VALUES
    ('CASE WHEN l=10 THEN 1000 ELSE 2000-100*(l-1) END',
     'CASE WHEN l=10 THEN 2000 ELSE 3000-100*(l-1) END'),
    ('CASE WHEN chosen_level=10 THEN 1000 ELSE 2000-100*(chosen_level-1) END',
     'CASE WHEN chosen_level=10 THEN 2000 ELSE 3000-100*(chosen_level-1) END'),
    ('jsonb_array_length(p_input->''questions'')<>10',
     'jsonb_array_length(p_input->''questions'')<>(CASE WHEN r.level<7 THEN 8 ELSE 10 END)'),
    ('WHERE q->>''book''=''kobun400'')<>2 OR',
     'WHERE q->>''book''=''kobun400'')<>(CASE WHEN r.level<7 THEN 0 ELSE 2 END) OR'),
    ('count(DISTINCT q->>''id'') FROM jsonb_array_elements(p_input->''questions'') q)<>10',
     'count(DISTINCT q->>''id'') FROM jsonb_array_elements(p_input->''questions'') q)<>(CASE WHEN r.level<7 THEN 8 ELSE 10 END)'),
    ('max_section:=1+(sections-1)*(r.level-1)/9;',
     'max_section:=CASE WHEN candidate->>''book''=''kobun400'' THEN r.level-6 ELSE 1+(sections-1)*(r.level-1)/9 END;')
   ) patches(old_text,new_text) LOOP
    marker:=item.old_text;replacement:=item.new_text;
    IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
     RAISE EXCEPTION 'Challenge question patch marker changed: %',marker; END IF;
    definition:=replace(definition,marker,replacement);
   END LOOP;
  END IF;
  EXECUTE definition;
 END LOOP;
END; $patch$;

-- Existing runs get the extra second immediately without applying old overdue
-- attacks. Valid question IDs/order survive. If any queued classical question is
-- now out of range, discard that whole block and freeze until the server refills
-- it; preserve HP, streak, answer counts, sequence, status, rewards and all audits.
DO $transition$
DECLARE cutover timestamptz:=clock_timestamp(); item record;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','a74ec6ae0fbe54fe6345daaee051b0ea'),
  ('target_private.challenge_dto(uuid,uuid)','09df7117fccb6b94451c193a607d549d'),
  ('target_private.challenge_tick(uuid,timestamptz)','dcc07c2a0175268b2daa49618a7eaaa8')
 ) expected(signature,digest) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.digest THEN
   RAISE EXCEPTION 'Unexpected gentler challenge definition: %',item.signature; END IF;
 END LOOP;
 UPDATE target_private.challenge_runs r SET
  attack_remaining_ms=CASE WHEN r.next_attack_at IS NULL THEN r.attack_remaining_ms
   ELSE greatest(0,ceil(extract(epoch FROM (r.next_attack_at-cutover))*1000)::integer) END+1000,
  next_attack_at=CASE WHEN r.status='playing' AND r.next_attack_at IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(r.questions) q WHERE q->>'book'='kobun400'
     AND (r.level<7 OR (q->>'number')::integer>100*(r.level-6)))
   THEN greatest(r.next_attack_at,cutover)+interval '1 second' ELSE NULL END,
  questions=CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(r.questions) q WHERE q->>'book'='kobun400'
   AND (r.level<7 OR (q->>'number')::integer>100*(r.level-6))) THEN '[]'::jsonb ELSE r.questions END,
  updated_at=cutover
 WHERE r.status IN ('playing','paused');
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
  <>'eafe8da70cbd3912d5310c083bdc303f' THEN
  RAISE EXCEPTION 'Challenge difficulty change altered shared finance'; END IF;
END; $transition$;
COMMIT;
