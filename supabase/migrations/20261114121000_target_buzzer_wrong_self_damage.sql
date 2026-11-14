-- Shared buzzer correction: wrong answers cost the answering player 10 HP.
-- First correct answer still deals exactly 5 HP to the opponent.
-- No existing wallets, bets, match history, rankings or prior receipts are altered.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);

DO $safe$
BEGIN
 IF to_regprocedure('public.target_buzzer_rpc(text,text,jsonb)') IS NULL OR
    to_regprocedure('target_private.battle_dto(uuid,uuid)') IS NULL OR
    to_regclass('target_private.battle_buzzer_attempts') IS NULL OR
    EXISTS(SELECT 1 FROM target_private.battle_matches WHERE status='playing') THEN
    RAISE EXCEPTION 'Buzzer penalty migration requires V2 schema and no funded in-progress match';
 END IF;
END; $safe$;

DO $buzzer_patch$
DECLARE def text; old_text text; new_text text; hits integer;
BEGIN
 SELECT pg_get_functiondef('public.target_buzzer_rpc(text,text,jsonb)'::regprocedure) INTO def;
 old_text:=$wrong_old$
 ELSE
   -- A wrong buzz uses the player's only answer but does NOT damage either HP.
   -- If both players miss, advance with no winner after the same brief feedback.
   IF (SELECT count(*) FROM target_private.battle_buzzer_attempts
       WHERE match_id=m.id AND round_no=r.round_no)>=2 THEN
     UPDATE target_private.battle_buzzer_rounds
       SET resolved_at=now_at,next_at=now_at+interval '1900 milliseconds'
       WHERE match_id=m.id AND round_no=r.round_no;
   END IF;
 END IF;
 answer_data:=jsonb_build_object('correct',was_correct,'damage',damage_value,$wrong_old$;
 new_text:=$wrong_new$
 ELSE
   -- Every wrong buzz costs its own player exactly 10 HP. It does not
   -- claim the attack, so the other player may still win this shared round.
   damage_value:=10;
   new_host_hp:=greatest(0,m.host_hp-(CASE WHEN member_side='host' THEN 10 ELSE 0 END));
   new_guest_hp:=greatest(0,m.guest_hp-(CASE WHEN member_side='guest' THEN 10 ELSE 0 END));
   UPDATE target_private.battle_matches
     SET host_hp=new_host_hp,guest_hp=new_guest_hp,updated_at=now_at,
       expires_at=now_at+interval '10 minutes' WHERE id=m.id;
   IF new_host_hp=0 OR new_guest_hp=0 THEN
     -- A self-inflicted knockout ends the round and settles the stake only once.
     UPDATE target_private.battle_buzzer_rounds
       SET resolved_at=now_at,next_at=now_at+interval '1900 milliseconds'
       WHERE match_id=m.id AND round_no=r.round_no;
     PERFORM target_private.battle_settle(m.id,
       CASE WHEN new_host_hp=0 THEN 'guest' ELSE 'host' END,'hp_zero');
   ELSIF (SELECT count(*) FROM target_private.battle_buzzer_attempts
       WHERE match_id=m.id AND round_no=r.round_no)>=2 THEN
     UPDATE target_private.battle_buzzer_rounds
       SET resolved_at=now_at,next_at=now_at+interval '1900 milliseconds'
       WHERE match_id=m.id AND round_no=r.round_no;
   END IF;
 END IF;
 answer_data:=jsonb_build_object('correct',was_correct,'damage',damage_value,$wrong_new$;
 hits:=(length(def)-length(replace(def,old_text,'')))/length(old_text);
 IF hits<>1 OR position('self-inflicted knockout' IN def)>0 THEN
   RAISE EXCEPTION 'Shared buzzer grading source changed, refusing unsafe penalty patch';
 END IF;
 EXECUTE replace(def,old_text,new_text);
 IF NOT has_function_privilege('anon','public.target_buzzer_rpc(text,text,jsonb)','EXECUTE')
   OR has_function_privilege('authenticated','public.target_buzzer_rpc(text,text,jsonb)','EXECUTE') THEN
   RAISE EXCEPTION 'Buzzer RPC security permissions drifted';
 END IF;
END; $buzzer_patch$;

DO $dto_patch$
DECLARE def text; old_text text; new_text text; hits integer;
BEGIN
 SELECT pg_get_functiondef('target_private.battle_dto(uuid,uuid)'::regprocedure) INTO def;
 old_text:=$dto_old$'roundResult',CASE WHEN r.resolved_at IS NULL THEN NULL ELSE jsonb_build_object($dto_old$;
 new_text:=$dto_new$'wrongHit',CASE WHEN r.match_id IS NULL OR m.status<>'playing' THEN NULL ELSE
    (SELECT jsonb_build_object('round',a.round_no,'damage',10,'createdAt',a.created_at)
     FROM target_private.battle_buzzer_attempts a
     WHERE a.match_id=r.match_id AND a.round_no=r.round_no
       AND a.member_id=p_member AND NOT a.correct) END,
  'roundResult',CASE WHEN r.resolved_at IS NULL THEN NULL ELSE jsonb_build_object($dto_new$;
 hits:=(length(def)-length(replace(def,old_text,'')))/length(old_text);
 IF hits<>1 OR position($flag$'wrongHit'$flag$ IN def)>0 THEN
   RAISE EXCEPTION 'Shared question DTO source changed, refusing unsafe private feedback patch';
 END IF;
 EXECUTE replace(def,old_text,new_text);
END; $dto_patch$;

COMMENT ON FUNCTION public.target_buzzer_rpc(text,text,jsonb) IS
 'Server-only same-question buzzer: first correct attacker deals 5 HP, every wrong answer self-damages 10 HP; server timestamps, private correct choice, idempotent settlement.';
COMMIT;
