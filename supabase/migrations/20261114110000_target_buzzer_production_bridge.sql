-- Maintain live V1 question compatibility while Vercel's daily deployment quota
-- prevents the already-tested shared-buzzer frontend from reaching Production.
-- Default TRUE keeps all fresh development/CI environments on strict V2.
-- Only an explicitly guarded production toggle sets FALSE temporarily.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);

DO $guard$
BEGIN
 IF to_regclass('target_private.battle_buzzer_rounds') IS NULL OR
    to_regprocedure('public.target_buzzer_rpc(text,text,jsonb)') IS NULL OR
    EXISTS(SELECT 1 FROM target_private.battle_matches WHERE status='playing') THEN
   RAISE EXCEPTION 'Bridge installation requires the shared-buzzer schema and zero active matches';
 END IF;
END; $guard$;

CREATE TABLE target_private.battle_release_flags (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  shared_enabled boolean NOT NULL DEFAULT true
);
INSERT INTO target_private.battle_release_flags(singleton,shared_enabled) VALUES (true,true);
ALTER TABLE target_private.battle_release_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE target_private.battle_release_flags FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE target_private.battle_release_flags IS
  'Trusted server-only migration cutover switch. FALSE permits old Production question clients until a new V2 Production build is verified.';

DO $patch_rpc$
DECLARE definition text; before_text text; after_text text; occurrences integer;
BEGIN
 SELECT pg_get_functiondef('public.target_battle_rpc(text,text,jsonb)'::regprocedure) INTO definition;
 before_text:='IF p_action IN (''next'',''answer'') THEN RETURN target_private.error_result(410,''BATTLE_SHARED_ROUNDS_ONLY'',''古い対戦画面を更新してください。''); END IF;';
 after_text:='IF p_action IN (''next'',''answer'') AND (SELECT shared_enabled FROM target_private.battle_release_flags WHERE singleton) THEN RETURN target_private.error_result(410,''BATTLE_SHARED_ROUNDS_ONLY'',''古い対戦画面を更新してください。''); END IF;';
 occurrences:=(length(definition)-length(replace(definition,before_text,'')))/length(before_text);
 IF occurrences<>1 OR position('battle_release_flags' IN definition)<>0 THEN
   RAISE EXCEPTION 'Existing legacy action guard has drifted; refuse unsafe patch'; END IF;
 EXECUTE replace(definition,before_text,after_text);
 IF NOT has_function_privilege('anon','public.target_battle_rpc(text,text,jsonb)','EXECUTE') OR
    has_function_privilege('authenticated','public.target_battle_rpc(text,text,jsonb)','EXECUTE') THEN
   RAISE EXCEPTION 'Target legacy RPC permissions drifted'; END IF;
END; $patch_rpc$;

DO $patch_dto$
DECLARE definition text; before_text text; after_text text; occurrences integer;
BEGIN
 SELECT pg_get_functiondef('target_private.battle_dto(uuid,uuid)'::regprocedure) INTO definition;
 before_text:=$old$'question',CASE WHEN m.status='playing' AND r.match_id IS NOT NULL
    THEN r.question-'correctChoiceId'-'correctText' ELSE NULL END,$old$;
 after_text:=$new$'question',CASE WHEN m.status='playing' THEN
    coalesce(
      r.question-'correctChoiceId'-'correctText',
      CASE WHEN NOT (SELECT shared_enabled FROM target_private.battle_release_flags WHERE singleton)
        THEN (SELECT q.question-'correctChoiceId'-'correctText'
              FROM target_private.battle_current_questions q
              WHERE q.match_id=m.id AND q.member_id=p_member)
        ELSE NULL END)
   ELSE NULL END,$new$;
 occurrences:=(length(definition)-length(replace(definition,before_text,'')))/length(before_text);
 IF occurrences<>1 OR position('battle_release_flags' IN definition)<>0 THEN
   RAISE EXCEPTION 'Existing shared question DTO has drifted; refuse unsafe patch'; END IF;
 EXECUTE replace(definition,before_text,after_text);
END; $patch_dto$;

COMMIT;
