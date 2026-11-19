-- One-time release check immediately after the authorized reset, before play.
-- Later legitimate starts/wins are checked by challenge_levels_verify.sql;
-- that general verifier deliberately does not require zero progress forever.
BEGIN READ ONLY;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(991101);
DO $once$
DECLARE item record;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','6bcffc66c8f4cf01aab57219ff140aae'),
  ('target_private.challenge_dto(uuid,uuid)','d0fdbe59478a7ebc3b479dc854090e29'),
  ('target_private.challenge_tick(uuid,timestamptz)','a81f2b827c4146ada04e2240a49cfc52'),
  ('target_private.challenge_storage_charge()','71d4ba2553f5ef56ca0ebc65063f42d9'),
  ('target_private.wallet_finance_projection(timestamptz)','bd93399757a066fdfb8f35e7e29af2dc')
 ) expected(signature,digest) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.digest THEN
   RAISE EXCEPTION 'Reset release function mismatch: %',item.signature; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM target_private.challenge_badges) OR
  EXISTS(SELECT 1 FROM target_private.challenge_runs WHERE status IN ('playing','paused')) THEN
  RAISE EXCEPTION 'One-time reset check requires empty progress and no old active run'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.challenge_badges'::regclass
  AND tgname='challenge_badges_immutable' AND tgenabled='O') OR
  NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.challenge_badges'::regclass
  AND tgname='challenge_badges_storage' AND tgenabled='O') THEN
  RAISE EXCEPTION 'Challenge badge immutability or quota trigger is disabled'; END IF;
END; $once$;
SELECT 'challenge_progress_reset_verified' AS result,
 (SELECT count(*) FROM target_private.challenge_badges) AS current_progress_badges,
 (SELECT count(*) FROM target_private.challenge_runs WHERE status IN ('playing','paused')) AS active_runs,
 (SELECT count(*) FROM target_private.challenge_reward_events) AS preserved_paid_clears,
 (SELECT coalesce(sum(amount),0) FROM target_private.challenge_reward_events) AS preserved_reward_total;
ROLLBACK;
