-- Generated with Supabase CLI migration new target_weight_workout_income.
-- Only newly submitted, authenticated Weight workouts earn rewards. Existing
-- profiles, records, items and rewards are never backfilled or rewritten.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock(991101);

CREATE TABLE target_private.weight_reward_receipts (
 member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
 session_id text NOT NULL CHECK(session_id ~ '^[A-Za-z0-9_-]{8,80}$'),
 reps integer NOT NULL CHECK(reps BETWEEN 1 AND 5000),
 amount bigint NOT NULL CHECK(amount=reps::bigint*1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(member_id,session_id)
);
CREATE INDEX weight_reward_receipts_member_created ON target_private.weight_reward_receipts(member_id,created_at);
ALTER TABLE target_private.weight_reward_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE target_private.weight_reward_receipts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION target_private.protect_weight_reward_receipt()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'Weight reward receipts are permanent' USING ERRCODE='42501';
END $$;
CREATE TRIGGER weight_reward_receipt_permanent BEFORE UPDATE OR DELETE ON target_private.weight_reward_receipts
 FOR EACH ROW EXECUTE FUNCTION target_private.protect_weight_reward_receipt();

CREATE FUNCTION target_private.weight_income(p_member uuid)
RETURNS bigint LANGUAGE sql STABLE STRICT SET search_path=pg_catalog AS $$
 SELECT coalesce(sum(amount),0)::bigint FROM target_private.weight_reward_receipts WHERE member_id=p_member;
$$;
CREATE FUNCTION target_private.weight_status(p_member uuid)
RETURNS jsonb LANGUAGE sql STABLE STRICT SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('weightIncome',target_private.weight_income(p_member),
   'totalIncome',coalesce(p.total_points,0),'balance',coalesce(p.total_points-p.spent_points,0))
 FROM (VALUES(p_member)) actor(member_id) LEFT JOIN target_private.profiles p USING(member_id);
$$;

-- Non-study rewards already share the casino_net financial component with
-- battle/challenge rewards. Weight retains its own immutable source ledger.
-- Extend the reviewed deployed projection without changing its existing
-- credit-mode logic, signature, cutoff rules or restoration behavior.
DO $projection$
DECLARE definition text; source text; marker text:='FROM target_private.challenge_reward_events';
BEGIN
 SELECT pg_get_functiondef(oid),prosrc INTO definition,source
 FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure;
 IF md5(source)<>'bd93399757a066fdfb8f35e7e29af2dc' OR
   (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 OR
   position('target_private.weight_reward_receipts' IN definition)>0 THEN
  RAISE EXCEPTION 'Reviewed Target finance projection changed; Weight migration is unsafe';
 END IF;
 EXECUTE replace(definition,marker,marker||' UNION ALL SELECT member_id,amount AS delta,created_at FROM target_private.weight_reward_receipts');
END $projection$;

CREATE FUNCTION public.target_weight_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 actor uuid; display_name text; session text; repetitions integer; amount bigint;
 profile target_private.profiles%ROWTYPE; receipt target_private.weight_reward_receipts%ROWTYPE;
 new_profile boolean; gross bigint; output jsonb;
BEGIN
 -- Like the existing Target RPCs, only a separate private server credential
 -- permits assertions of an already authenticated KGS identity.
 IF p_secret IS NULL OR length(p_secret)<32 OR length(p_secret)>256 OR NOT EXISTS(
   SELECT 1 FROM target_private.server_credentials WHERE singleton AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
  RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。');
 END IF;
 IF p_action IS NULL OR p_action NOT IN ('status','credit') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR
   pg_column_size(p_input)>2048 OR (SELECT count(*) FROM jsonb_object_keys(p_input))<>(CASE WHEN p_action='credit' THEN 4 ELSE 2 END) OR
   jsonb_typeof(p_input->'memberId') IS DISTINCT FROM 'string' OR coalesce(p_input->>'memberId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
   jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR length(p_input->>'name')>100 OR length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 20 OR
   NOT(p_input?'memberId' AND p_input?'name') THEN
  RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
 END IF;
 actor:=(p_input->>'memberId')::uuid; display_name:=btrim(p_input->>'name');
 IF p_action='status' THEN RETURN target_private.weight_status(actor); END IF;
 IF jsonb_typeof(p_input->'sessionId') IS DISTINCT FROM 'string' OR coalesce(p_input->>'sessionId','')!~'^[A-Za-z0-9_-]{8,80}$' OR
   jsonb_typeof(p_input->'reps') IS DISTINCT FROM 'number' OR coalesce(p_input->>'reps','')!~'^[1-9][0-9]{0,3}$' THEN
  RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
 END IF;
 session:=p_input->>'sessionId'; repetitions:=(p_input->>'reps')::integer;
 IF repetitions NOT BETWEEN 1 AND 5000 THEN RETURN target_private.error_result(400,'INVALID_REQUEST','回数を確認してください。'); END IF;
 amount:=repetitions::bigint*1000;
 PERFORM pg_advisory_xact_lock(991101);
 SELECT * INTO receipt FROM target_private.weight_reward_receipts WHERE member_id=actor AND session_id=session;
 IF FOUND THEN
  IF receipt.reps<>repetitions THEN RETURN target_private.error_result(409,'REQUEST_ID_CONFLICT','同じ記録の回数が一致しません。'); END IF;
  RETURN target_private.weight_status(actor)||jsonb_build_object('sessionId',session,'reps',receipt.reps,'creditedAmount',receipt.amount,'replayed',true);
 END IF;
 SELECT * INTO profile FROM target_private.profiles WHERE member_id=actor FOR UPDATE;
 new_profile:=NOT FOUND;
 IF new_profile AND (SELECT count(*) FROM target_private.profiles)>=500 THEN
  RETURN target_private.error_result(507,'CAPACITY_LIMIT','アカウント数の上限に達しました。');
 END IF;
 gross:=target_private.weight_income(actor);
 IF coalesce(profile.total_points,0)>10000000000000-amount OR coalesce(profile.casino_net,0)>10000000000000-amount OR
   coalesce(profile.wallet_revision,0)>=10000000000000 OR gross>10000000000000-amount THEN
  RETURN target_private.error_result(507,'INCOME_LIMIT','総取得の上限に達しました。');
 END IF;
 IF (SELECT logical_bytes FROM target_private.system_state WHERE singleton FOR UPDATE)>104857600-256 THEN
  RETURN target_private.error_result(507,'CAPACITY_LIMIT','保存容量の上限に達しました。');
 END IF;
 IF new_profile THEN INSERT INTO target_private.profiles(member_id,name) VALUES(actor,display_name); END IF;
 INSERT INTO target_private.weight_reward_receipts(member_id,session_id,reps,amount) VALUES(actor,session,repetitions,amount);
 UPDATE target_private.profiles SET total_points=total_points+amount,casino_net=casino_net+amount,name=display_name,updated_at=clock_timestamp() WHERE member_id=actor;
 UPDATE target_private.system_state SET logical_bytes=logical_bytes+256 WHERE singleton;
 output:=target_private.weight_status(actor);
 RETURN output||jsonb_build_object('sessionId',session,'reps',repetitions,'creditedAmount',amount,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION target_private.protect_weight_reward_receipt(),target_private.weight_income(uuid),target_private.weight_status(uuid),public.target_weight_rpc(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.target_weight_rpc(text,text,jsonb) TO anon;
NOTIFY pgrst,'reload schema';
COMMIT;
