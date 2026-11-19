'use strict';
// Pure operator preparation: this module never connects to a database. The
// immutable roster is supplied by the operator; amounts are calculated only
// after acquiring the wallet ledger lock in the generated transaction.
const crypto = require('node:crypto');

function normalizeSnapshot(snapshot) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      !/^income_adjust_[a-zA-Z0-9_-]{1,66}$/.test(snapshot.operationId || '') ||
      snapshot.amount !== 1000000 || !uuid.test(snapshot.protectedId || '') ||
      typeof snapshot.reason !== 'string' || !Array.isArray(snapshot.targets) ||
      !Number.isInteger(snapshot.expectedCount) || snapshot.expectedCount < 1 ||
      snapshot.expectedCount > 500 || snapshot.expectedCount !== snapshot.targets.length) {
    throw Error('Invalid frozen million-grant snapshot.');
  }
  const reason = snapshot.reason.trim();
  if (!reason || reason.includes('\0') || [...reason].length > 100) throw Error('Invalid grant reason.');
  const protectedId = snapshot.protectedId.toLowerCase();
  const targets = snapshot.targets.map(target => {
    if (!target || !uuid.test(target.memberId || '') || typeof target.name !== 'string') throw Error('Invalid grant member.');
    const name = target.name.trim(), memberId = target.memberId.toLowerCase();
    if (![...name].length || [...name].length > 20 || name.includes('\0') || memberId === protectedId) throw Error('Invalid or protected grant member.');
    return { memberId, name };
  }).sort((a, b) => a.memberId.localeCompare(b.memberId));
  if (new Set(targets.map(target => target.memberId)).size !== targets.length) throw Error('Duplicate grant member.');
  const core = { operationId: snapshot.operationId, reason, amount: 1000000, protectedId, targets, expectedCount: targets.length };
  const rosterSha256 = crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
  return { ...core, rosterSha256, auditReason: `${reason} [grant-sha256:${rosterSha256}]` };
}

function buildGrantSql(snapshot) {
  const canonical = normalizeSnapshot(snapshot);
  // Hex makes every member label inert SQL data, including quotes/backslashes.
  const hex = Buffer.from(JSON.stringify(canonical), 'utf8').toString('hex');
  return `-- Explicit one-time million grant; frozen roster SHA256 ${canonical.rosterSha256}
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '90s';
DO $million_grant$
DECLARE
  request jsonb := convert_from(decode('${hex}','hex'),'UTF8')::jsonb;
  operation_id text := request->>'operationId';
  reason text := request->>'auditReason';
  grant_amount bigint := (request->>'amount')::bigint;
  member_ids uuid[];
  members integer := (request->>'expectedCount')::integer;
  missing integer; existing_profiles integer; created_profiles integer := 0;
  logical_before bigint; charged_bytes bigint; event_exists boolean;
  existing target_private.wallet_restoration_events%rowtype;
  manifest jsonb; before_targets jsonb; before_others text; after_others text;
  before_system jsonb; before_history jsonb := '{}'::jsonb; after_history jsonb := '{}'::jsonb;
  old_snapshot jsonb; receipt_valid boolean; result jsonb;
  table_name text; table_hash text; table_filter text; pass integer;
BEGIN
  SELECT array_agg((value->>'memberId')::uuid ORDER BY (value->>'memberId')::uuid)
    INTO member_ids FROM jsonb_array_elements(request->'targets');
  PERFORM pg_advisory_xact_lock(991101);
  SELECT logical_bytes,to_jsonb(s)-'logical_bytes' INTO STRICT logical_before,before_system
    FROM target_private.system_state s WHERE singleton FOR UPDATE;
  LOCK TABLE target_private.profiles IN SHARE ROW EXCLUSIVE MODE;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.adjust_wallet_income(text,jsonb)'::regprocedure)
      IS DISTINCT FROM '586881b0d1c17ba3538ebc9af30a18e8' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
      IS DISTINCT FROM '8e69577732c1f54b2dae637b87aa3fd6' THEN
    RAISE EXCEPTION 'Reviewed grant accounting implementation changed' USING ERRCODE='23514';
  END IF;

  -- Look up the durable operation BEFORE deriving totals from current wallets.
  -- Replays use original receipt values, so later legitimate earnings survive.
  SELECT * INTO existing FROM target_private.wallet_restoration_events WHERE reset_id=operation_id;
  event_exists := FOUND;
  IF event_exists THEN
    IF existing.member_count<>members OR existing.cutoff_at IS DISTINCT FROM existing.prepared_at OR
      (SELECT array_agg(member_id ORDER BY member_id) FROM target_private.wallet_restorations WHERE reset_id=operation_id)
        IS DISTINCT FROM member_ids THEN
      RAISE EXCEPTION 'Grant operation is bound to a different roster' USING ERRCODE='22023';
    END IF;
  END IF;

  -- Check historical receipts on replay, and newly written receipts on apply.
  -- Non-financial source fields and recorded spending must be identical.
  FOR pass IN 0..1 LOOP
    IF pass=0 AND NOT event_exists THEN
      IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l
        JOIN target_private.profiles p USING(member_id)
        WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
          IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
        RAISE EXCEPTION 'Wallet projection drift before grant' USING ERRCODE='23514';
      END IF;
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text,'' ORDER BY member_id),'')) INTO before_others
        FROM target_private.profiles p WHERE NOT(member_id=ANY(member_ids));
      -- Hash source, ownership and match tables inside the ledger lock. Rate
      -- counters/presence are transient and are deliberately outside this audit.
      FOR table_name IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='target_private' AND c.relkind='r' AND
          c.relname NOT IN ('profiles','system_state','rate_limits','two_player_lobby_presence') AND
          c.relname NOT LIKE '%credentials' AND c.relname NOT LIKE '%rates' ORDER BY c.relname LOOP
        table_filter := CASE WHEN table_name IN ('wallet_restoration_events','wallet_restorations')
          THEN format(' WHERE reset_id<>%L',operation_id) ELSE '' END;
        EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text),%L ORDER BY md5(to_jsonb(t)::text)),%L)) FROM target_private.%I t%s',
          '','',table_name,table_filter) INTO table_hash;
        before_history := before_history || jsonb_build_object(table_name,table_hash);
      END LOOP;
      SELECT count(*)::integer,count(*) FILTER(WHERE member_id=ANY(member_ids))::integer
        INTO existing_profiles,missing FROM target_private.profiles;
      missing := members-missing;
      IF existing_profiles+missing>500 THEN RAISE EXCEPTION 'Grant profile capacity exceeded' USING ERRCODE='54000'; END IF;
      charged_bytes := missing*512::bigint+1024+members*4096::bigint;
      IF logical_before>104857600-charged_bytes THEN RAISE EXCEPTION 'Grant storage capacity exceeded' USING ERRCODE='54000'; END IF;
      IF missing>0 THEN
        UPDATE target_private.system_state SET logical_bytes=logical_bytes+missing*512::bigint WHERE singleton;
        INSERT INTO target_private.profiles(member_id,name)
          SELECT (t->>'memberId')::uuid,t->>'name' FROM jsonb_array_elements(request->'targets') t
          WHERE NOT EXISTS(SELECT 1 FROM target_private.profiles p WHERE p.member_id=(t->>'memberId')::uuid);
        GET DIAGNOSTICS created_profiles=ROW_COUNT;
        IF created_profiles<>missing THEN RAISE EXCEPTION 'Grant missing-profile set changed' USING ERRCODE='23514'; END IF;
      END IF;
      SELECT jsonb_object_agg(member_id::text,to_jsonb(p)) INTO before_targets
        FROM target_private.profiles p WHERE member_id=ANY(member_ids);
      SELECT jsonb_build_object('version',1,'reason',reason,'targets',jsonb_agg(
        jsonb_build_object('memberId',member_id::text,'expectedName',name,'totalIncome',total_points+grant_amount)
        ORDER BY member_id)) INTO manifest FROM target_private.profiles WHERE member_id=ANY(member_ids);
      result := target_private.adjust_wallet_income(operation_id,manifest);
      IF result->>'replayed' IS DISTINCT FROM 'false' OR (result->>'members')::integer<>members THEN
        RAISE EXCEPTION 'Unexpected grant application result' USING ERRCODE='23514';
      END IF;
      CONTINUE;
    END IF;

    SELECT bool_and(
      r.spent_refund=0 AND r.before_state=r.after_void_state AND
      r.component_deltas=jsonb_build_object('totalPoints',grant_amount,'spentPoints',0,'calculusPoints',0,'birthdayPoints',0,
        'casinoNet',grant_amount,'calculusForgivenPoints',0,'rawStudyPoints',0,
        'incomeCorrection',jsonb_build_object('kind','authorized_income_adjustment_v1','version',1,
          'reason',reason,'memberId',r.member_id::text,'expectedName',r.component_deltas->'incomeCorrection'->>'expectedName',
          'totalIncome',(r.restored_state->>'totalPoints')::bigint,'spendingPolicy','preserve')) AND
      (r.restored_state->>'totalPoints')::bigint=(r.before_state->>'totalPoints')::bigint+grant_amount AND
      (r.restored_state->>'casinoNet')::bigint=(r.before_state->>'casinoNet')::bigint+grant_amount AND
      (r.restored_state->>'walletRevision')::bigint=(r.before_state->>'walletRevision')::bigint+1 AND
      r.restored_state-ARRAY['totalPoints','casinoNet','walletRevision']=r.before_state-ARRAY['totalPoints','casinoNet','walletRevision'])
      INTO receipt_valid FROM target_private.wallet_restorations r WHERE reset_id=operation_id;
    SELECT jsonb_build_object('version',1,'reason',reason,'targets',jsonb_agg(jsonb_build_object(
      'memberId',member_id::text,'expectedName',component_deltas->'incomeCorrection'->>'expectedName',
      'totalIncome',(restored_state->>'totalPoints')::bigint) ORDER BY member_id)),
      jsonb_object_agg(member_id::text,before_state) INTO manifest,old_snapshot
      FROM target_private.wallet_restorations WHERE reset_id=operation_id;
    SELECT * INTO STRICT existing FROM target_private.wallet_restoration_events WHERE reset_id=operation_id;
    IF receipt_valid IS DISTINCT FROM true OR existing.member_count<>members OR
      (SELECT array_agg(member_id ORDER BY member_id) FROM target_private.wallet_restorations WHERE reset_id=operation_id)
        IS DISTINCT FROM member_ids OR existing.cutoff_at IS DISTINCT FROM existing.prepared_at OR
      existing.source_manifest_sha256<>encode(sha256(convert_to(manifest::text,'UTF8')),'hex') OR
      existing.before_snapshot_sha256<>encode(sha256(convert_to(old_snapshot::text,'UTF8')),'hex') THEN
      RAISE EXCEPTION 'Grant operation metadata or financial receipts disagree' USING ERRCODE='22023';
    END IF;
    EXIT;
  END LOOP;

  IF NOT event_exists THEN
    IF EXISTS(SELECT 1 FROM target_private.profiles p WHERE member_id=ANY(member_ids) AND (
      to_jsonb(p)-ARRAY['total_points','casino_net','wallet_revision','updated_at'] IS DISTINCT FROM
        (before_targets->member_id::text)-ARRAY['total_points','casino_net','wallet_revision','updated_at'] OR
      total_points<>((before_targets->member_id::text)->>'total_points')::bigint+grant_amount OR
      casino_net<>((before_targets->member_id::text)->>'casino_net')::bigint+grant_amount OR
      wallet_revision<>((before_targets->member_id::text)->>'wallet_revision')::bigint+1)) THEN
      RAISE EXCEPTION 'Grant changed unrelated member fields' USING ERRCODE='23514';
    END IF;
    SELECT md5(coalesce(string_agg(to_jsonb(p)::text,'' ORDER BY member_id),'')) INTO after_others
      FROM target_private.profiles p WHERE NOT(member_id=ANY(member_ids));
    IF after_others IS DISTINCT FROM before_others THEN RAISE EXCEPTION 'Grant changed an excluded wallet' USING ERRCODE='23514'; END IF;
    FOR table_name IN SELECT jsonb_object_keys(before_history) LOOP
      table_filter := CASE WHEN table_name IN ('wallet_restoration_events','wallet_restorations')
        THEN format(' WHERE reset_id<>%L',operation_id) ELSE '' END;
      EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text),%L ORDER BY md5(to_jsonb(t)::text)),%L)) FROM target_private.%I t%s',
        '','',table_name,table_filter) INTO table_hash;
      after_history := after_history || jsonb_build_object(table_name,table_hash);
    END LOOP;
    IF after_history IS DISTINCT FROM before_history THEN RAISE EXCEPTION 'Grant changed existing source, inventory or match history' USING ERRCODE='23514'; END IF;
    IF (SELECT logical_bytes FROM target_private.system_state WHERE singleton)<>logical_before+charged_bytes OR
      (SELECT to_jsonb(s)-'logical_bytes' FROM target_private.system_state s WHERE singleton) IS DISTINCT FROM before_system THEN
      RAISE EXCEPTION 'Grant storage charge or source counters disagree' USING ERRCODE='23514';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet projection drift after grant' USING ERRCODE='23514';
  END IF;
  PERFORM set_config('target.operator_grant_result',jsonb_build_object('operationId',operation_id,'members',members,
    'amountPerMember',grant_amount,'totalGranted',members*grant_amount,'createdProfiles',created_profiles,
    'replayed',event_exists,'rosterSha256',request->>'rosterSha256','protectedPreserved',true,
    'otherProfilesPreserved',true,'historyPreserved',true,'projectionMismatches',0)::text,true);
END $million_grant$;
SELECT current_setting('target.operator_grant_result')::jsonb AS grant;
COMMIT;
`;
}

module.exports = { buildGrantSql, normalizeSnapshot };
