-- Reveal only the just-graded choice ID after an answer is accepted.
-- Upcoming question DTOs, immutable old receipts, combat, clocks and finance stay intact.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
DO $feedback$
DECLARE definition text; marker text; finance_before text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure)
  IS DISTINCT FROM 'b74f38f7d92fc6839eeaf854292f4f12' THEN
  RAISE EXCEPTION 'Reviewed special-pause RPC changed before graded-choice feedback'; END IF;
 SELECT md5(prosrc) INTO finance_before FROM pg_proc
  WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure;
 IF finance_before IS NULL THEN RAISE EXCEPTION 'Shared financial projection missing'; END IF;
 SELECT pg_get_functiondef('public.target_challenge_rpc(text,text,jsonb)'::regprocedure) INTO definition;
 marker:='answer_data:=jsonb_build_object(''correct'',accepted,''damage'',damage,';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Graded-choice feedback marker changed'; END IF;
 EXECUTE replace(definition,marker,
  'answer_data:=jsonb_build_object(''correct'',accepted,''correctChoiceId'',question->>''correctChoiceId'',''damage'',damage,');
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure)
  IS DISTINCT FROM '66e060d1532f0fa08800f30579897d9a' THEN
  RAISE EXCEPTION 'Unexpected graded-choice feedback RPC definition'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
  IS DISTINCT FROM finance_before THEN
  RAISE EXCEPTION 'Graded-choice feedback changed shared financial projection'; END IF;
END; $feedback$;
COMMIT;
