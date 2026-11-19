-- Generated with Supabase CLI migration new target_two_player_soccer.
-- Local reviewed mechanism only. Provision the separate credential hash privately.
-- Existing game writers remain retired; no historical receipt is rewritten.
BEGIN;
SELECT pg_advisory_xact_lock(991101);

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
      IS DISTINCT FROM '049a8d9c1d86e1b9c8f77f65f82ddbb3' OR
     (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_games_rpc(text,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '71ddbc56e79a79dcd8a046d556b73a59' THEN
    RAISE EXCEPTION 'Reviewed financial projection or retired game boundary changed';
  END IF;
END $guard$;

CREATE TABLE target_private.two_player_credentials (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  key_hash text NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE target_private.two_player_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK(code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','playing','finished','cancelled')),
  host_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
  guest_id uuid REFERENCES target_private.profiles(member_id),
  host_name text NOT NULL CHECK(length(host_name) BETWEEN 1 AND 20),
  guest_name text CHECK(length(guest_name) BETWEEN 1 AND 20),
  host_offer integer NOT NULL CHECK(host_offer BETWEEN 100 AND 100000 AND host_offer%100=0),
  guest_offer integer CHECK(guest_offer BETWEEN 100 AND 100000 AND guest_offer%100=0),
  host_ready boolean NOT NULL DEFAULT false,
  guest_ready boolean NOT NULL DEFAULT false,
  host_cancel boolean NOT NULL DEFAULT false,
  guest_cancel boolean NOT NULL DEFAULT false,
  stake integer CHECK(stake BETWEEN 100 AND 100000 AND stake%100=0),
  escrow integer NOT NULL DEFAULT 0 CHECK(escrow BETWEEN 0 AND 200000 AND escrow%200=0),
  round integer NOT NULL DEFAULT 1 CHECK(round BETWEEN 1 AND 40),
  version integer NOT NULL DEFAULT 1 CHECK(version=1),
  turn text NOT NULL DEFAULT 'host' CHECK(turn IN ('host','guest')),
  state jsonb NOT NULL DEFAULT '{"players":[{"x":320,"y":720},{"x":320,"y":240}],"ball":{"x":320,"y":480}}'
    CHECK(jsonb_typeof(state)='object' AND pg_column_size(state)<=8192),
  host_score integer NOT NULL DEFAULT 0 CHECK(host_score BETWEEN 0 AND 3),
  guest_score integer NOT NULL DEFAULT 0 CHECK(guest_score BETWEEN 0 AND 3),
  winner text CHECK(winner IN ('host','guest','draw')),
  reason text CHECK(length(reason)<=80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
  settled_at timestamptz,
  CHECK(guest_id IS NULL OR guest_id<>host_id),
  CHECK((status='playing' AND stake IS NOT NULL AND escrow=2*stake AND guest_id IS NOT NULL AND host_ready AND guest_ready)
    OR (status<>'playing' AND escrow=0)),
  CHECK((status IN ('waiting','playing') AND settled_at IS NULL AND winner IS NULL)
    OR (status IN ('finished','cancelled') AND settled_at IS NOT NULL)),
  CHECK(status<>'finished' OR winner IS NOT NULL)
);
CREATE INDEX two_player_matches_host ON target_private.two_player_matches(host_id,created_at DESC);
CREATE INDEX two_player_matches_guest ON target_private.two_player_matches(guest_id,created_at DESC) WHERE guest_id IS NOT NULL;
CREATE INDEX two_player_matches_expiry ON target_private.two_player_matches(expires_at) WHERE status IN ('waiting','playing');
CREATE TABLE target_private.two_player_participants (
  member_id uuid PRIMARY KEY REFERENCES target_private.profiles(member_id),
  match_id uuid NOT NULL REFERENCES target_private.two_player_matches(id)
);
CREATE INDEX two_player_participants_match ON target_private.two_player_participants(match_id);
CREATE TABLE target_private.two_player_moves (
  match_id uuid NOT NULL REFERENCES target_private.two_player_matches(id),
  round integer NOT NULL CHECK(round BETWEEN 1 AND 40),
  version integer NOT NULL CHECK(version=1),
  actor text NOT NULL CHECK(actor IN ('host','guest')),
  angle integer NOT NULL CHECK(angle BETWEEN 0 AND 359),
  power integer NOT NULL CHECK(power BETWEEN 0 AND 100),
  claim_token uuid,
  claim_until timestamptz,
  result_hash text CHECK(result_hash ~ '^[a-f0-9]{64}$'),
  goal text CHECK(goal IN ('host','guest')),
  frames jsonb CHECK(jsonb_typeof(frames)='array' AND pg_column_size(frames)<=112640),
  state jsonb CHECK(jsonb_typeof(state)='object' AND pg_column_size(state)<=8192),
  charged_bytes integer NOT NULL DEFAULT 131072 CHECK(charged_bytes BETWEEN 1024 AND 131072),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY(match_id,round),
  CHECK((resolved_at IS NULL AND result_hash IS NULL) OR
    (resolved_at IS NOT NULL AND result_hash IS NOT NULL AND state IS NOT NULL AND frames IS NOT NULL))
);
CREATE TABLE target_private.two_player_wallet_events (
  match_id uuid NOT NULL REFERENCES target_private.two_player_matches(id),
  member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
  phase text NOT NULL CHECK(phase IN ('reserve','settle')),
  kind text NOT NULL CHECK(kind IN ('reserve','payout','refund')),
  delta integer NOT NULL CHECK(delta BETWEEN -100000 AND 200000 AND delta%100=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(match_id,member_id,phase),
  CHECK((phase='reserve' AND kind='reserve' AND delta<0) OR
    (phase='settle' AND kind IN ('payout','refund') AND delta>=0))
);
CREATE INDEX two_player_wallet_events_member ON target_private.two_player_wallet_events(member_id,created_at);
CREATE TABLE target_private.two_player_requests (
  member_id uuid NOT NULL REFERENCES target_private.profiles(member_id),
  request_id uuid NOT NULL,
  action text NOT NULL CHECK(length(action)<=12),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  match_id uuid NOT NULL REFERENCES target_private.two_player_matches(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(member_id,request_id)
);
CREATE INDEX two_player_requests_match ON target_private.two_player_requests(match_id,member_id);
CREATE TABLE target_private.two_player_rates (
  member_id uuid PRIMARY KEY REFERENCES target_private.profiles(member_id),
  minute_bucket bigint NOT NULL,
  minute_count integer NOT NULL CHECK(minute_count BETWEEN 1 AND 241),
  day_bucket bigint NOT NULL,
  create_count integer NOT NULL DEFAULT 0 CHECK(create_count BETWEEN 0 AND 20),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE target_private.two_player_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.two_player_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.two_player_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.two_player_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.two_player_wallet_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.two_player_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_private.two_player_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE target_private.two_player_credentials,target_private.two_player_matches,
  target_private.two_player_participants,target_private.two_player_moves,target_private.two_player_wallet_events,
  target_private.two_player_requests,target_private.two_player_rates FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION target_private.two_player_charge(p_bytes integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE target_private.system_state SET logical_bytes=logical_bytes+p_bytes
    WHERE singleton AND p_bytes>0 AND logical_bytes<=104857600-p_bytes;
  IF NOT FOUND THEN RAISE EXCEPTION 'Soccer storage capacity exceeded' USING ERRCODE='54000'; END IF;
END $$;

CREATE FUNCTION target_private.two_player_permanent()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Soccer receipts are permanent' USING ERRCODE='42501'; END $$;
CREATE TRIGGER two_player_wallet_events_permanent BEFORE UPDATE OR DELETE ON target_private.two_player_wallet_events
  FOR EACH ROW EXECUTE FUNCTION target_private.two_player_permanent();
CREATE TRIGGER two_player_requests_permanent BEFORE UPDATE OR DELETE ON target_private.two_player_requests
  FOR EACH ROW EXECUTE FUNCTION target_private.two_player_permanent();

-- Resolved moves, locked inputs and the physics version cannot be rewritten.
CREATE FUNCTION target_private.two_player_protect_move()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.resolved_at IS NOT NULL OR
    (NEW.match_id,NEW.round,NEW.version,NEW.actor,NEW.angle,NEW.power,NEW.created_at)
      IS DISTINCT FROM (OLD.match_id,OLD.round,OLD.version,OLD.actor,OLD.angle,OLD.power,OLD.created_at) THEN
    RAISE EXCEPTION 'Soccer input/result is immutable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER two_player_moves_locked BEFORE UPDATE OR DELETE ON target_private.two_player_moves
  FOR EACH ROW EXECUTE FUNCTION target_private.two_player_protect_move();

-- Retain headroom for the entire possible payout while the shared wallet earns
-- new study/source income. Settlement closes the escrow before crediting it.
CREATE FUNCTION target_private.two_player_wallet_headroom()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE pending integer;
BEGIN
  SELECT coalesce(max(m.escrow),0) INTO pending FROM target_private.two_player_participants a
    JOIN target_private.two_player_matches m ON m.id=a.match_id WHERE a.member_id=NEW.member_id AND m.status='playing';
  IF pending>0 AND (NEW.total_points>10000000000000-pending OR NEW.casino_net>10000000000000-pending OR
      NEW.wallet_revision>=10000000000000) THEN
    RAISE EXCEPTION 'Wallet must retain soccer settlement headroom' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER two_player_wallet_headroom BEFORE UPDATE OF total_points,casino_net,spent_points ON target_private.profiles
  FOR EACH ROW EXECUTE FUNCTION target_private.two_player_wallet_headroom();

CREATE FUNCTION target_private.two_player_guard_restoration()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE cutoff_value timestamptz; prepared_value timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  SELECT e.cutoff_at,e.prepared_at INTO STRICT cutoff_value,prepared_value
    FROM target_private.wallet_restoration_events e WHERE e.reset_id=NEW.reset_id;
  IF cutoff_value<prepared_value AND EXISTS(SELECT 1 FROM target_private.two_player_participants a
      JOIN target_private.two_player_matches m ON m.id=a.match_id WHERE a.member_id=NEW.member_id AND m.status='playing') THEN
    RAISE EXCEPTION 'Cancel and refund funded soccer matches before historical wallet restoration' USING ERRCODE='23514';
  END IF;
  -- Even a terminal match cannot be sliced between its reserve and payout.
  -- That historical projection contains a debit with no corresponding escrow.
  IF cutoff_value<prepared_value AND EXISTS(SELECT 1 FROM target_private.two_player_wallet_events reserve
    WHERE reserve.member_id=NEW.member_id AND reserve.phase='reserve' AND reserve.created_at<cutoff_value
      AND NOT EXISTS(SELECT 1 FROM target_private.two_player_wallet_events settle
        WHERE settle.match_id=reserve.match_id AND settle.member_id=reserve.member_id AND settle.phase='settle'
          AND settle.created_at<cutoff_value)) THEN
    RAISE EXCEPTION 'Historical wallet cutoff intersects a soccer escrow interval' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER two_player_restoration_guard BEFORE INSERT ON target_private.wallet_restorations
  FOR EACH ROW EXECUTE FUNCTION target_private.two_player_guard_restoration();

-- Adapt only the reviewed games CTE, retaining every existing correction,
-- external source recovery and exact purchase-receipt write-off component.
DO $projection$
DECLARE definition text; old_value text; new_value text;
BEGIN
  SELECT pg_get_functiondef('target_private.wallet_finance_projection(timestamptz)'::regprocedure) INTO definition;
  old_value:='games AS(SELECT a.member_id,sum(a.net)::bigint amount FROM target_private.casino_rounds a';
  new_value:='games AS(SELECT a.member_id,sum(a.net)::bigint amount FROM ('||
    'SELECT member_id,net,created_at FROM target_private.casino_rounds UNION ALL '||
    'SELECT member_id,delta,created_at FROM target_private.two_player_wallet_events) a';
  IF (length(definition)-length(replace(definition,old_value,'')))/length(old_value)<>1 THEN
    RAISE EXCEPTION 'Reviewed financial games component does not match'; END IF;
  EXECUTE replace(definition,old_value,new_value);
END $projection$;

CREATE FUNCTION target_private.two_player_wallet(p_member uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT target_private.games_wallet(p_member)||jsonb_build_object('escrow',coalesce((
    SELECT m.stake FROM target_private.two_player_participants a JOIN target_private.two_player_matches m ON m.id=a.match_id
      WHERE a.member_id=p_member AND m.status='playing'),0));
$$;

CREATE FUNCTION target_private.two_player_match_dto(p_id uuid,p_summary boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',m.id,'code',m.code,'status',m.status,'mode','alternating',
    'host',jsonb_build_object('memberId',m.host_id,'name',m.host_name,'offer',m.host_offer,'ready',m.host_ready,
      'inputLocked',EXISTS(SELECT 1 FROM target_private.two_player_moves x WHERE x.match_id=m.id AND x.round=m.round AND x.actor='host' AND x.resolved_at IS NULL),'cancelRequested',m.host_cancel),
    'guest',CASE WHEN m.guest_id IS NULL THEN NULL ELSE jsonb_build_object('memberId',m.guest_id,'name',m.guest_name,
      'offer',m.guest_offer,'ready',m.guest_ready,'inputLocked',EXISTS(SELECT 1 FROM target_private.two_player_moves x
        WHERE x.match_id=m.id AND x.round=m.round AND x.actor='guest' AND x.resolved_at IS NULL),'cancelRequested',m.guest_cancel) END,
    'stake',m.stake,'escrow',m.escrow,'round',m.round,'version',m.version,'turn',m.turn,'state',m.state,
    'scores',jsonb_build_object('host',m.host_score,'guest',m.guest_score),'winner',m.winner,'reason',m.reason,
    'createdAt',m.created_at,'expiresAt',m.expires_at,'settledAt',m.settled_at,
    'lastRound',CASE WHEN p_summary THEN NULL ELSE (SELECT jsonb_build_object('round',x.round,'version',x.version,
      'inputs',jsonb_build_object('host',jsonb_build_object('angle',CASE WHEN x.actor='host' THEN x.angle ELSE 0 END,'power',CASE WHEN x.actor='host' THEN x.power ELSE 0 END),
        'guest',jsonb_build_object('angle',CASE WHEN x.actor='guest' THEN x.angle ELSE 0 END,'power',CASE WHEN x.actor='guest' THEN x.power ELSE 0 END)),
      'goal',x.goal,'frames',x.frames,'state',x.state,'resultHash',x.result_hash)
      FROM target_private.two_player_moves x WHERE x.match_id=m.id AND x.resolved_at IS NOT NULL ORDER BY x.round DESC LIMIT 1) END)
  FROM target_private.two_player_matches m WHERE m.id=p_id;
$$;

CREATE FUNCTION target_private.two_player_money(p_id uuid,p_member uuid,p_phase text,p_kind text,p_delta integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO target_private.two_player_wallet_events(match_id,member_id,phase,kind,delta)
    VALUES(p_id,p_member,p_phase,p_kind,p_delta);
  IF p_delta<>0 THEN
    UPDATE target_private.profiles SET total_points=total_points+p_delta,casino_net=casino_net+p_delta,updated_at=now()
      WHERE member_id=p_member;
  END IF;
END $$;

CREATE FUNCTION target_private.two_player_settle(p_id uuid,p_status text,p_winner text,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE m target_private.two_player_matches%rowtype;
BEGIN
  SELECT * INTO STRICT m FROM target_private.two_player_matches WHERE id=p_id FOR UPDATE;
  IF m.status IN ('finished','cancelled') THEN RETURN; END IF;
  IF p_status NOT IN ('finished','cancelled') OR (p_status='finished' AND p_winner NOT IN ('host','guest','draw')) THEN
    RAISE EXCEPTION 'Invalid soccer settlement' USING ERRCODE='22023'; END IF;
  UPDATE target_private.two_player_matches SET status=p_status,escrow=0,winner=p_winner,reason=p_reason,
    settled_at=clock_timestamp() WHERE id=p_id;
  IF m.escrow>0 THEN
    PERFORM target_private.two_player_money(p_id,m.host_id,'settle',CASE WHEN p_winner IN ('host','guest') THEN 'payout' ELSE 'refund' END,
      CASE WHEN p_winner='host' THEN m.escrow WHEN p_winner='guest' THEN 0 ELSE m.stake END);
    PERFORM target_private.two_player_money(p_id,m.guest_id,'settle',CASE WHEN p_winner IN ('host','guest') THEN 'payout' ELSE 'refund' END,
      CASE WHEN p_winner='guest' THEN m.escrow WHEN p_winner='host' THEN 0 ELSE m.stake END);
  END IF;
  DELETE FROM target_private.two_player_participants WHERE match_id=p_id;
  -- Cancellation/expiry never allocates fresh storage. Release unused result
  -- reservations but retain the locked input and its permanent request receipt.
  WITH released AS(UPDATE target_private.two_player_moves SET charged_bytes=1024,claim_token=NULL,claim_until=NULL
    WHERE match_id=p_id AND resolved_at IS NULL AND charged_bytes>1024 RETURNING 131072-1024 AS bytes)
    UPDATE target_private.system_state SET logical_bytes=logical_bytes-coalesce((SELECT sum(bytes) FROM released),0) WHERE singleton;
END $$;

CREATE FUNCTION target_private.two_player_expire(p_member uuid DEFAULT NULL,p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE m record; count_value integer:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);
  FOR m IN SELECT id FROM target_private.two_player_matches WHERE status IN ('waiting','playing') AND expires_at<=clock_timestamp()
    AND (p_member IS NULL OR host_id=p_member OR guest_id=p_member) ORDER BY expires_at LIMIT least(greatest(p_limit,1),100) FOR UPDATE LOOP
    PERFORM target_private.two_player_settle(m.id,'cancelled',NULL,'idle_timeout'); count_value:=count_value+1;
  END LOOP;
  -- Rate slots are reusable; permanent money, input and idempotency rows stay.
  WITH gone AS(DELETE FROM target_private.two_player_rates WHERE updated_at<clock_timestamp()-interval '1 day' RETURNING member_id)
    UPDATE target_private.system_state SET logical_bytes=logical_bytes-256*(SELECT count(*) FROM gone) WHERE singleton;
  RETURN count_value;
END $$;

CREATE FUNCTION target_private.two_player_claim(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE m target_private.two_player_matches%rowtype; x target_private.two_player_moves%rowtype;
BEGIN
  SELECT * INTO STRICT m FROM target_private.two_player_matches WHERE id=p_id;
  IF m.status<>'playing' THEN RETURN NULL; END IF;
  SELECT * INTO x FROM target_private.two_player_moves WHERE match_id=p_id AND round=m.round AND resolved_at IS NULL FOR UPDATE;
  IF NOT FOUND OR x.claim_until>clock_timestamp() THEN RETURN NULL; END IF;
  UPDATE target_private.two_player_moves SET claim_token=gen_random_uuid(),claim_until=clock_timestamp()+interval '10 seconds'
    WHERE match_id=p_id AND round=m.round RETURNING * INTO x;
  RETURN jsonb_build_object('claimToken',x.claim_token,'matchId',m.id,'round',m.round,'version',m.version,'turn',m.turn,'state',m.state,
    'inputs',jsonb_build_object('host',jsonb_build_object('angle',CASE WHEN x.actor='host' THEN x.angle ELSE 0 END,'power',CASE WHEN x.actor='host' THEN x.power ELSE 0 END),
      'guest',jsonb_build_object('angle',CASE WHEN x.actor='guest' THEN x.angle ELSE 0 END,'power',CASE WHEN x.actor='guest' THEN x.power ELSE 0 END)));
END $$;

-- The sole Data API boundary uses a dedicated server credential. KGS session
-- verification happens on the trusted application server; actor fields are not
-- taken from the browser. No service-role key grants private table access.
CREATE FUNCTION public.two_player_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  member_uuid uuid; request_uuid uuid; match_uuid uuid; input_hash text;
  display_name text; side text; code_value text; stake_value integer;
  round_value integer; goal_value text; result_hash_value text; result_value jsonb;
  m target_private.two_player_matches%rowtype; x target_private.two_player_moves%rowtype;
  previous target_private.two_player_requests%rowtype; profile target_private.profiles%rowtype;
  rates target_private.two_player_rates%rowtype;
  minute_value bigint:=floor(extract(epoch FROM clock_timestamp())/60)::bigint;
  day_value bigint:=floor(extract(epoch FROM clock_timestamp())/86400)::bigint;
  processing jsonb; response_value jsonb; allowed_keys text[]; is_mutation boolean;
BEGIN
  -- Gate BEFORE parsing input, rates, locks, row allocation or expiration.
  IF p_secret IS NULL OR length(p_secret)<32 OR length(p_secret)>256 OR NOT EXISTS(
    SELECT 1 FROM target_private.two_player_credentials WHERE singleton
      AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
    RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('wallet','list','create','join','offer','ready','state','input','resolve','cancel','expire') OR
    p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR pg_column_size(p_input)>(CASE WHEN p_action='resolve' THEN 131072 ELSE 4096 END) THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
  END IF;
  is_mutation:=p_action IN ('create','join','offer','ready','input','resolve','cancel');
  allowed_keys:=ARRAY['memberId','name'];
  IF is_mutation THEN allowed_keys:=allowed_keys||ARRAY['requestId']; END IF;
  IF p_action IN ('state','offer','ready','input','resolve','cancel') THEN allowed_keys:=allowed_keys||ARRAY['matchId','code']; END IF;
  IF p_action IN ('create','offer') THEN allowed_keys:=allowed_keys||ARRAY['stake']; END IF;
  IF p_action='join' THEN allowed_keys:=allowed_keys||ARRAY['code']; END IF;
  IF p_action='ready' THEN allowed_keys:=allowed_keys||ARRAY['ready']; END IF;
  IF p_action='input' THEN allowed_keys:=allowed_keys||ARRAY['round','version','angle','power']; END IF;
  IF p_action='resolve' THEN allowed_keys:=allowed_keys||ARRAY['round','version','claimToken','goal','state','frames']; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE NOT(k=ANY(allowed_keys))) OR
    jsonb_typeof(p_input->'memberId') IS DISTINCT FROM 'string' OR
    coalesce(p_input->>'memberId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
    jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 20 OR
    (is_mutation AND (jsonb_typeof(p_input->'requestId') IS DISTINCT FROM 'string' OR
      coalesce(p_input->>'requestId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')) THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
  END IF;
  IF p_action IN ('state','offer','ready','input','resolve','cancel') THEN
    IF (p_input?'matchId')=(p_input?'code') OR
      ((p_input?'matchId') AND (jsonb_typeof(p_input->'matchId') IS DISTINCT FROM 'string' OR
        coalesce(p_input->>'matchId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')) OR
      ((p_input?'code') AND (jsonb_typeof(p_input->'code') IS DISTINCT FROM 'string' OR
        coalesce(p_input->>'code','')!~'^[A-HJ-NP-Z2-9]{6}$')) THEN
      RETURN target_private.error_result(400,'INVALID_REQUEST','部屋を選び直してください。'); END IF;
  END IF;
  IF p_action='join' AND (jsonb_typeof(p_input->'code') IS DISTINCT FROM 'string' OR
      coalesce(p_input->>'code','')!~'^[A-HJ-NP-Z2-9]{6}$') THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','部屋コードを確認してください。'); END IF;
  IF p_action IN ('create','offer') THEN
    IF jsonb_typeof(p_input->'stake') IS DISTINCT FROM 'number' OR coalesce(p_input->>'stake','')!~'^[0-9]{3,6}$' THEN
      RETURN target_private.error_result(400,'INVALID_STAKE','賭け金は100〜100,000轟の100轟単位です。'); END IF;
    stake_value:=(p_input->>'stake')::integer;
    IF stake_value NOT BETWEEN 100 AND 100000 OR stake_value%100<>0 THEN
      RETURN target_private.error_result(400,'INVALID_STAKE','賭け金は100〜100,000轟の100轟単位です。'); END IF;
  END IF;
  IF p_action='ready' AND jsonb_typeof(p_input->'ready') IS DISTINCT FROM 'boolean' THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','確認内容を選び直してください。'); END IF;
  IF p_action IN ('input','resolve') THEN
    IF jsonb_typeof(p_input->'round') IS DISTINCT FROM 'number' OR coalesce(p_input->>'round','')!~'^[0-9]{1,2}$' OR
      p_input->'version' IS DISTINCT FROM '1'::jsonb THEN
      RETURN target_private.error_result(400,'INVALID_REQUEST','手番を読み直してください。'); END IF;
    round_value:=(p_input->>'round')::integer;
    IF round_value NOT BETWEEN 1 AND 40 THEN
      RETURN target_private.error_result(400,'INVALID_REQUEST','手番を読み直してください。'); END IF;
  END IF;
  IF p_action='input' AND (jsonb_typeof(p_input->'angle') IS DISTINCT FROM 'number' OR
    jsonb_typeof(p_input->'power') IS DISTINCT FROM 'number' OR coalesce(p_input->>'angle','')!~'^[0-9]{1,3}$' OR
    coalesce(p_input->>'power','')!~'^[0-9]{1,3}$' OR (p_input->>'angle')::integer NOT BETWEEN 0 AND 359 OR
    (p_input->>'power')::integer NOT BETWEEN 0 AND 100) THEN
    RETURN target_private.error_result(400,'INVALID_INPUT','角度または強さを確認してください。'); END IF;
  IF p_action='resolve' THEN
    IF jsonb_typeof(p_input->'claimToken') IS DISTINCT FROM 'string' OR
      coalesce(p_input->>'claimToken','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
      jsonb_typeof(p_input->'state') IS DISTINCT FROM 'object' OR pg_column_size(p_input->'state')>8192 OR
      jsonb_typeof(p_input->'frames') IS DISTINCT FROM 'array' OR pg_column_size(p_input->'frames')>112640 OR
      jsonb_array_length(p_input->'frames')>2001 OR NOT(p_input?'goal') OR
      (p_input->'goal'<>'null'::jsonb AND (jsonb_typeof(p_input->'goal') IS DISTINCT FROM 'string' OR
        p_input->>'goal' NOT IN ('host','guest'))) THEN
      RETURN target_private.error_result(400,'INVALID_RESULT','計算結果を確認できませんでした。'); END IF;
    goal_value:=p_input->>'goal';
  END IF;

  member_uuid:=(p_input->>'memberId')::uuid; display_name:=btrim(p_input->>'name');
  IF is_mutation THEN request_uuid:=(p_input->>'requestId')::uuid;
    input_hash:=encode(sha256(convert_to(jsonb_build_object('action',p_action,'input',p_input)::text,'UTF8')),'hex'); END IF;
  PERFORM pg_advisory_xact_lock(991101);
  -- Profile/rate rows have fixed charges and no browser-controlled large values.
  SELECT * INTO profile FROM target_private.profiles WHERE member_id=member_uuid FOR UPDATE;
  IF NOT FOUND THEN
    IF (SELECT count(*) FROM target_private.profiles)>=500 THEN
      RETURN target_private.error_result(507,'CAPACITY_LIMIT','利用者数の上限に達しました。'); END IF;
    PERFORM target_private.two_player_charge(512);
    INSERT INTO target_private.profiles(member_id,name) VALUES(member_uuid,display_name);
  ELSIF profile.name<>display_name THEN
    UPDATE target_private.profiles SET name=display_name,updated_at=now() WHERE member_id=member_uuid;
  END IF;
  PERFORM target_private.two_player_expire(member_uuid,1);
  SELECT * INTO rates FROM target_private.two_player_rates WHERE member_id=member_uuid FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM target_private.two_player_charge(256);
    INSERT INTO target_private.two_player_rates(member_id,minute_bucket,minute_count,day_bucket)
      VALUES(member_uuid,minute_value,1,day_value) RETURNING * INTO rates;
  ELSE
    UPDATE target_private.two_player_rates SET minute_bucket=minute_value,
      minute_count=CASE WHEN minute_bucket=minute_value THEN least(minute_count+1,241) ELSE 1 END,
      day_bucket=day_value,create_count=CASE WHEN day_bucket=day_value THEN create_count ELSE 0 END,updated_at=clock_timestamp()
      WHERE member_id=member_uuid RETURNING * INTO rates;
  END IF;
  IF rates.minute_count>240 THEN RETURN target_private.error_result(429,'RATE_LIMIT','少し待ってからお試しください。'); END IF;

  IF p_action IN ('wallet','expire') THEN
    RETURN jsonb_build_object('ok',true,'wallet',target_private.two_player_wallet(member_uuid));
  ELSIF p_action='list' THEN
    SELECT coalesce(jsonb_agg(target_private.two_player_match_dto(r.id,true) ORDER BY r.active DESC,r.created_at DESC),'[]'::jsonb)
      INTO result_value FROM (SELECT id,created_at,(status IN ('waiting','playing')) active FROM target_private.two_player_matches
      WHERE host_id=member_uuid OR guest_id=member_uuid ORDER BY (status IN ('waiting','playing')) DESC,created_at DESC LIMIT 20) r;
    RETURN jsonb_build_object('ok',true,'wallet',target_private.two_player_wallet(member_uuid),'rooms',result_value);
  END IF;

  IF is_mutation THEN
    SELECT * INTO previous FROM target_private.two_player_requests WHERE member_id=member_uuid AND request_id=request_uuid;
    IF FOUND THEN
      IF previous.action<>p_action OR previous.payload_hash<>input_hash THEN
        RETURN target_private.error_result(409,'REQUEST_CONFLICT','同じ送信IDの内容が変わっています。'); END IF;
      processing:=target_private.two_player_claim(previous.match_id);
      RETURN jsonb_build_object('ok',true,'replayed',true,'wallet',target_private.two_player_wallet(member_uuid),
        'match',target_private.two_player_match_dto(previous.match_id))||
        CASE WHEN processing IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('_processing',processing) END;
    END IF;
  END IF;

  IF p_action='create' THEN
    IF EXISTS(SELECT 1 FROM target_private.two_player_participants WHERE member_id=member_uuid) THEN
      RETURN target_private.error_result(409,'ACTIVE_MATCH','参加中の部屋を再開してください。'); END IF;
    IF rates.create_count>=20 THEN RETURN target_private.error_result(429,'CREATE_LIMIT','本日の作成回数の上限に達しました。'); END IF;
    -- Match, two participant slots, four finance events and two cancellation
    -- request receipts have a fixed permanent budget independent of retries.
    PERFORM target_private.two_player_charge(16384);
    -- A UUID supplies random bits independently of connection/polling order.
    LOOP
      code_value:=''; input_hash:=replace(gen_random_uuid()::text,'-','');
      FOR stake_value IN 0..5 LOOP
        code_value:=code_value||substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',1+get_byte(decode(input_hash,'hex'),stake_value)%32,1);
      END LOOP;
      EXIT WHEN NOT EXISTS(SELECT 1 FROM target_private.two_player_matches WHERE code=code_value);
    END LOOP;
    stake_value:=(p_input->>'stake')::integer;
    INSERT INTO target_private.two_player_matches(code,host_id,host_name,host_offer)
      VALUES(code_value,member_uuid,display_name,stake_value) RETURNING * INTO m;
    INSERT INTO target_private.two_player_participants(member_id,match_id) VALUES(member_uuid,m.id);
    UPDATE target_private.two_player_rates SET create_count=create_count+1 WHERE member_id=member_uuid;
    input_hash:=encode(sha256(convert_to(jsonb_build_object('action',p_action,'input',p_input)::text,'UTF8')),'hex');
  ELSE
    IF p_input?'matchId' THEN match_uuid:=(p_input->>'matchId')::uuid;
      SELECT * INTO m FROM target_private.two_player_matches WHERE id=match_uuid FOR UPDATE;
    ELSE SELECT * INTO m FROM target_private.two_player_matches WHERE code=p_input->>'code' FOR UPDATE; END IF;
    IF m.id IS NULL THEN RETURN target_private.error_result(404,'MATCH_NOT_FOUND','部屋が見つかりません。'); END IF;
    IF p_action='join' THEN
      IF m.host_id=member_uuid OR m.guest_id=member_uuid THEN NULL;
      ELSIF m.status<>'waiting' OR m.guest_id IS NOT NULL OR m.expires_at<=clock_timestamp() THEN
        RETURN target_private.error_result(409,'ROOM_UNAVAILABLE','この部屋には参加できません。');
      ELSIF EXISTS(SELECT 1 FROM target_private.two_player_participants WHERE member_id=member_uuid) THEN
        RETURN target_private.error_result(409,'ACTIVE_MATCH','参加中の部屋を再開してください。');
      ELSE
        UPDATE target_private.two_player_matches SET guest_id=member_uuid,guest_name=display_name,
          guest_offer=host_offer,host_ready=false,guest_ready=false,expires_at=clock_timestamp()+interval '10 minutes' WHERE id=m.id RETURNING * INTO m;
        INSERT INTO target_private.two_player_participants(member_id,match_id) VALUES(member_uuid,m.id);
      END IF;
    ELSIF member_uuid<>m.host_id AND member_uuid IS DISTINCT FROM m.guest_id THEN
      RETURN target_private.error_result(404,'MATCH_NOT_FOUND','部屋が見つかりません。');
    END IF;
    side:=CASE WHEN member_uuid=m.host_id THEN 'host' ELSE 'guest' END;
    IF p_action='state' THEN
      processing:=target_private.two_player_claim(m.id);
      RETURN jsonb_build_object('ok',true,'wallet',target_private.two_player_wallet(member_uuid),'match',target_private.two_player_match_dto(m.id))||
        CASE WHEN processing IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('_processing',processing) END;
    ELSIF p_action='offer' THEN
      IF m.status<>'waiting' THEN RETURN target_private.error_result(409,'MATCH_STARTED','開始済みの賭け金は変更できません。'); END IF;
      UPDATE target_private.two_player_matches SET host_offer=CASE WHEN side='host' THEN stake_value ELSE host_offer END,
        guest_offer=CASE WHEN side='guest' THEN stake_value ELSE guest_offer END,host_ready=false,guest_ready=false,
        expires_at=clock_timestamp()+interval '10 minutes' WHERE id=m.id RETURNING * INTO m;
    ELSIF p_action='ready' THEN
      IF m.status<>'waiting' OR m.guest_id IS NULL THEN RETURN target_private.error_result(409,'NOT_READY','2人そろってから確認してください。'); END IF;
      IF (p_input->>'ready')::boolean AND m.host_offer<>m.guest_offer THEN
        RETURN target_private.error_result(409,'STAKE_MISMATCH','2人の賭け金を同じ金額にしてください。'); END IF;
      UPDATE target_private.two_player_matches SET host_ready=CASE WHEN side='host' THEN (p_input->>'ready')::boolean ELSE host_ready END,
        guest_ready=CASE WHEN side='guest' THEN (p_input->>'ready')::boolean ELSE guest_ready END,
        expires_at=clock_timestamp()+interval '10 minutes' WHERE id=m.id RETURNING * INTO m;
      IF m.host_ready AND m.guest_ready THEN
        -- Lock both shared wallets in stable order and validate before either debit.
        PERFORM 1 FROM target_private.profiles WHERE member_id IN (m.host_id,m.guest_id) ORDER BY member_id FOR UPDATE;
        IF EXISTS(SELECT 1 FROM target_private.profiles p WHERE p.member_id IN (m.host_id,m.guest_id) AND
          (p.total_points-p.spent_points<m.host_offer OR p.total_points+m.host_offer>10000000000000 OR
            p.casino_net-m.host_offer< -10000000000000 OR p.casino_net+m.host_offer>10000000000000 OR p.wallet_revision>=9999999999999)) THEN
          -- Undo only this request's confirmation; the prior player's consent remains.
          UPDATE target_private.two_player_matches SET host_ready=CASE WHEN side='host' THEN false ELSE host_ready END,
            guest_ready=CASE WHEN side='guest' THEN false ELSE guest_ready END WHERE id=m.id;
          RETURN target_private.error_result(409,'INSUFFICIENT_BALANCE','2人とも賭け金を払える残高が必要です。');
        END IF;
        PERFORM target_private.two_player_money(m.id,m.host_id,'reserve','reserve',-m.host_offer);
        PERFORM target_private.two_player_money(m.id,m.guest_id,'reserve','reserve',-m.host_offer);
        UPDATE target_private.two_player_matches SET status='playing',stake=host_offer,escrow=2*host_offer,
          turn=CASE WHEN get_byte(decode(replace(gen_random_uuid()::text,'-',''),'hex'),0)%2=0 THEN 'host' ELSE 'guest' END,
          expires_at=clock_timestamp()+interval '10 minutes' WHERE id=m.id RETURNING * INTO m;
      END IF;
    ELSIF p_action='input' THEN
      IF m.status<>'playing' OR round_value<>m.round THEN RETURN target_private.error_result(409,'STALE_INPUT','手番が進みました。画面を読み直してください。'); END IF;
      IF side<>m.turn THEN RETURN target_private.error_result(409,'NOT_YOUR_TURN','相手の手番です。'); END IF;
      SELECT * INTO x FROM target_private.two_player_moves WHERE match_id=m.id AND round=m.round;
      IF FOUND THEN
        IF x.actor<>side OR x.angle<>(p_input->>'angle')::integer OR x.power<>(p_input->>'power')::integer THEN
          RETURN target_private.error_result(409,'INPUT_LOCKED','確定済みの入力は変更できません。'); END IF;
      ELSE
        -- Reserve the entire bounded result BEFORE accepting a move so even a
        -- nearly full database can always resolve or refund an accepted input.
        PERFORM target_private.two_player_charge(131072);
        INSERT INTO target_private.two_player_moves(match_id,round,version,actor,angle,power)
          VALUES(m.id,m.round,1,side,(p_input->>'angle')::integer,(p_input->>'power')::integer);
        UPDATE target_private.two_player_matches SET expires_at=clock_timestamp()+interval '10 minutes' WHERE id=m.id;
      END IF;
    ELSIF p_action='resolve' THEN
      SELECT * INTO x FROM target_private.two_player_moves WHERE match_id=m.id AND round=round_value FOR UPDATE;
      result_value:=jsonb_build_object('goal',p_input->'goal','state',p_input->'state','frames',p_input->'frames');
      result_hash_value:=encode(sha256(convert_to(result_value::text,'UTF8')),'hex');
      IF x.match_id IS NULL THEN RETURN target_private.error_result(409,'NO_INPUT','確定済みの入力がありません。'); END IF;
      IF x.resolved_at IS NOT NULL THEN
        IF x.result_hash<>result_hash_value THEN RETURN target_private.error_result(409,'RESULT_CONFLICT','確定済みの結果は変更できません。'); END IF;
        RETURN jsonb_build_object('ok',true,'replayed',true,'wallet',target_private.two_player_wallet(member_uuid),
          'match',target_private.two_player_match_dto(m.id));
      ELSE
        IF m.status<>'playing' OR m.round<>round_value OR x.claim_token IS DISTINCT FROM (p_input->>'claimToken')::uuid OR
          x.claim_until IS NULL OR x.claim_until<=clock_timestamp() THEN
          RETURN target_private.error_result(409,'STALE_CLAIM','計算の担当が更新されました。'); END IF;
        UPDATE target_private.two_player_moves SET result_hash=result_hash_value,goal=goal_value,frames=p_input->'frames',state=p_input->'state',
          charged_bytes=2048+pg_column_size(p_input->'frames')+pg_column_size(p_input->'state'),
          resolved_at=clock_timestamp(),claim_until=NULL WHERE match_id=m.id AND round=round_value;
        UPDATE target_private.system_state SET logical_bytes=logical_bytes-(131072-2048-pg_column_size(p_input->'frames')-pg_column_size(p_input->'state'))
          WHERE singleton;
        UPDATE target_private.two_player_matches SET state=CASE WHEN goal_value IS NULL THEN p_input->'state' ELSE
          '{"players":[{"x":320,"y":720},{"x":320,"y":240}],"ball":{"x":320,"y":480}}'::jsonb END,
          host_score=host_score+CASE WHEN goal_value='host' THEN 1 ELSE 0 END,
          guest_score=guest_score+CASE WHEN goal_value='guest' THEN 1 ELSE 0 END WHERE id=m.id RETURNING * INTO m;
        IF m.host_score=3 OR m.guest_score=3 THEN
          PERFORM target_private.two_player_settle(m.id,'finished',CASE WHEN m.host_score=3 THEN 'host' ELSE 'guest' END,'three_goals');
        ELSIF m.round=40 THEN
          PERFORM target_private.two_player_settle(m.id,'finished','draw','forty_moves');
        ELSE
          UPDATE target_private.two_player_matches SET round=round+1,turn=CASE WHEN turn='host' THEN 'guest' ELSE 'host' END,
            expires_at=clock_timestamp()+interval '10 minutes' WHERE id=m.id;
        END IF;
      END IF;
    ELSIF p_action='cancel' THEN
      IF m.status IN ('finished','cancelled') OR (side='host' AND m.host_cancel) OR (side='guest' AND m.guest_cancel) THEN
        RETURN jsonb_build_object('ok',true,'replayed',true,'wallet',target_private.two_player_wallet(member_uuid),
          'match',target_private.two_player_match_dto(m.id)); END IF;
      IF m.status='waiting' THEN PERFORM target_private.two_player_settle(m.id,'cancelled',NULL,'cancelled_before_funding');
      ELSIF m.status='playing' THEN
        UPDATE target_private.two_player_matches SET host_cancel=host_cancel OR side='host',guest_cancel=guest_cancel OR side='guest'
          WHERE id=m.id RETURNING * INTO m;
        IF m.host_cancel AND m.guest_cancel THEN PERFORM target_private.two_player_settle(m.id,'cancelled',NULL,'mutual_cancel'); END IF;
      END IF;
    END IF;
  END IF;
  IF p_action NOT IN ('resolve','cancel') AND (SELECT count(*) FROM target_private.two_player_requests WHERE match_id=m.id AND member_id=member_uuid)>=256 THEN
    RAISE EXCEPTION 'Soccer request capacity exceeded' USING ERRCODE='54000'; END IF;
  -- Each first resolution receipt is covered by its already-reserved move
  -- budget. Repeated resolutions return above without allocating any row.
  IF p_action NOT IN ('resolve','cancel') THEN PERFORM target_private.two_player_charge(512); END IF;
  INSERT INTO target_private.two_player_requests(member_id,request_id,action,payload_hash,match_id)
    VALUES(member_uuid,request_uuid,p_action,input_hash,m.id);
  processing:=target_private.two_player_claim(m.id);
  RETURN jsonb_build_object('ok',true,'wallet',target_private.two_player_wallet(member_uuid),'match',target_private.two_player_match_dto(m.id))||
    CASE WHEN processing IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('_processing',processing) END;
EXCEPTION WHEN SQLSTATE '54000' THEN
  -- The exception rolls back all work in this invocation, including a partially
  -- accepted confirmation, debit, result, request receipt or rate allocation.
  RETURN target_private.error_result(507,'CAPACITY_LIMIT','保存容量の上限に達しました。');
END $$;

REVOKE ALL ON FUNCTION target_private.two_player_charge(integer),target_private.two_player_permanent(),
  target_private.two_player_protect_move(),target_private.two_player_wallet_headroom(),target_private.two_player_guard_restoration(),
  target_private.two_player_wallet(uuid),target_private.two_player_match_dto(uuid,boolean),
  target_private.two_player_money(uuid,uuid,text,text,integer),target_private.two_player_settle(uuid,text,text,text),
  target_private.two_player_expire(uuid,integer),target_private.two_player_claim(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.two_player_rpc(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.two_player_rpc(text,text,jsonb) TO anon,authenticated,service_role;
COMMENT ON FUNCTION public.two_player_rpc(text,text,jsonb) IS
  'Dedicated-credential server RPC for alternating live soccer PvP, shared-wallet escrow and immutable deterministic results; never forward _processing to browsers.';

-- A supported hosted pg_cron installation handles idle refunds without visits.
-- Plain local PostgreSQL fixtures have no pg_cron and intentionally skip it.
DO $cron$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule('two-player-soccer-expiry','* * * * *',
      'SELECT target_private.two_player_expire(NULL,100);');
  END IF;
END $cron$;
COMMIT;
