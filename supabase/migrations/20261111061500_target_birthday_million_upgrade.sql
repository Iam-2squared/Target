-- KGS 11th annual birthday 1,000,000-todo gift (JST 2026-11-11 onward).
-- The already-seen 100k birthday receipt is preserved forever; a separate
-- immutable 900k supplemental ledger makes the same-year upgrade idempotent.
-- ONLY apply to the Target Supabase project.
SELECT pg_advisory_xact_lock(991101);
CREATE TABLE IF NOT EXISTS target_private.birthday_upgrades(
 member_id uuid NOT NULL,
 gift_year integer NOT NULL,
 amount bigint NOT NULL DEFAULT 900000 CHECK(amount=900000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 seen_at timestamptz NULL,
 PRIMARY KEY(member_id,gift_year),
 FOREIGN KEY(member_id,gift_year) REFERENCES target_private.birthday_receipts(member_id,gift_year),
 CHECK(seen_at IS NULL OR (isfinite(seen_at) AND seen_at>=created_at))
);
ALTER TABLE target_private.birthday_upgrades ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON target_private.birthday_upgrades FROM PUBLIC,anon,authenticated;
-- The only legal mutation after creation is marking an unread supplement seen.
CREATE OR REPLACE FUNCTION target_private.guard_birthday_upgrade()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $up$
BEGIN
 IF TG_OP='UPDATE' AND OLD.seen_at IS NULL AND NEW.seen_at IS NOT NULL
   AND NEW.member_id=OLD.member_id AND NEW.gift_year=OLD.gift_year
   AND NEW.amount=OLD.amount AND NEW.created_at=OLD.created_at
   AND NEW.seen_at>=OLD.created_at THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Birthday financial upgrade is immutable' USING ERRCODE='42501';
END $up$;
REVOKE ALL ON FUNCTION target_private.guard_birthday_upgrade() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS birthday_upgrade_immutable ON target_private.birthday_upgrades;
CREATE TRIGGER birthday_upgrade_immutable
  BEFORE UPDATE OR DELETE ON target_private.birthday_upgrades
  FOR EACH ROW EXECUTE FUNCTION target_private.guard_birthday_upgrade();
-- Grant future birthdays 1m; allow pre-upgrade 100k receipts unchanged.
ALTER TABLE target_private.birthday_receipts DROP CONSTRAINT birthday_receipts_amount_check;
ALTER TABLE target_private.birthday_receipts ADD CONSTRAINT birthday_receipts_amount_check
  CHECK(amount=100000 OR (amount=1000000 AND birthday_date>=DATE '2026-11-11'));
CREATE OR REPLACE FUNCTION target_private.birthday_status(p_member uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'pg_catalog' AS $status$
 SELECT jsonb_build_object('gift',(
   SELECT jsonb_build_object(
     'giftYear',r.gift_year,
     'birthdayDate',to_char(r.birthday_date,'YYYY-MM-DD'),
     'amount',r.amount+coalesce(u.amount,0),
     'seen',CASE WHEN u.member_id IS NULL THEN r.seen_at IS NOT NULL ELSE u.seen_at IS NOT NULL END)
   FROM target_private.birthday_receipts r
   LEFT JOIN target_private.birthday_upgrades u USING(member_id,gift_year)
   WHERE r.member_id=p_member AND (
     (CASE WHEN u.member_id IS NULL THEN r.seen_at IS NULL ELSE u.seen_at IS NULL END)
     OR r.gift_year=extract(year FROM current_timestamp AT TIME ZONE 'Asia/Tokyo')::integer
   )
   ORDER BY (CASE WHEN u.member_id IS NULL THEN r.seen_at IS NULL ELSE u.seen_at IS NULL END) DESC,r.gift_year DESC LIMIT 1
 ));
$status$;
CREATE OR REPLACE FUNCTION public.target_birthday_rpc(p_secret text, p_action text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  member_uuid uuid; display_name text; birthday_value date; year_value integer;
  today date:=(current_timestamp AT TIME ZONE 'Asia/Tokyo')::date;
  entry jsonb; granted integer:=0; bytes_value bigint:=0; profile_count integer:=0; gift_amount bigint;
BEGIN
  IF p_secret IS NULL OR length(p_secret)<32 OR length(p_secret)>256 OR NOT EXISTS(
    SELECT 1 FROM target_private.server_credentials WHERE singleton AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
    RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。'); END IF;
  IF p_action IS NULL OR p_action NOT IN ('grant','status','seen') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR pg_column_size(p_input)>65536 THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
  IF p_action IN ('status','seen') THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>(CASE WHEN p_action='seen' THEN 2 ELSE 1 END) OR
      NOT(p_input?'memberId') OR coalesce(p_input->>'memberId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
      (p_action='seen' AND (NOT(p_input?'giftYear') OR jsonb_typeof(p_input->'giftYear') IS DISTINCT FROM 'number' OR
        coalesce(p_input->>'giftYear','')!~'^[1-9][0-9]{0,3}$')) THEN
      RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
    member_uuid:=(p_input->>'memberId')::uuid;
    IF p_action='seen' THEN
      year_value:=(p_input->>'giftYear')::integer;
      IF year_value>extract(year FROM today)::integer THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
      PERFORM pg_advisory_xact_lock(991101);
      -- Extra 900k upgrade is a distinct immutable receipt; reopening the
      -- greeting only marks that supplemental receipt as acknowledged.
      UPDATE target_private.birthday_upgrades SET seen_at=greatest(clock_timestamp(),created_at)
        WHERE member_id=member_uuid AND gift_year=year_value AND seen_at IS NULL;
      UPDATE target_private.birthday_receipts SET seen_at=greatest(clock_timestamp(),created_at)
        WHERE member_id=member_uuid AND gift_year=year_value AND seen_at IS NULL;
    END IF;
    RETURN target_private.birthday_status(member_uuid);
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>1 OR NOT(p_input?'gifts') OR jsonb_typeof(p_input->'gifts') IS DISTINCT FROM 'array' THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
  IF jsonb_array_length(p_input->'gifts') NOT BETWEEN 1 AND 100 THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
  FOR entry IN SELECT v FROM jsonb_array_elements(p_input->'gifts') v LOOP
    IF jsonb_typeof(entry)<>'object' THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(entry))<>3 OR NOT(entry?&ARRAY['memberId','name','birthdayDate']) OR
      coalesce(entry->>'memberId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR
      jsonb_typeof(entry->'name') IS DISTINCT FROM 'string' OR length(btrim(coalesce(entry->>'name',''))) NOT BETWEEN 1 AND 20 OR
      jsonb_typeof(entry->'birthdayDate') IS DISTINCT FROM 'string' OR coalesce(entry->>'birthdayDate','')!~'^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
    BEGIN birthday_value:=(entry->>'birthdayDate')::date;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END;
    IF birthday_value>today THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
  END LOOP;
  -- Duplicate annual keys inside a batch are rejected; subsequent requests can
  -- safely replay any year, including a changed profile birthday in that year.
  IF (SELECT count(DISTINCT ((v->>'memberId')::uuid,extract(year FROM (v->>'birthdayDate')::date))) FROM jsonb_array_elements(p_input->'gifts') v)
    <>jsonb_array_length(p_input->'gifts') THEN RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。'); END IF;
  PERFORM pg_advisory_xact_lock(991101);
  FOR entry IN SELECT v FROM jsonb_array_elements(p_input->'gifts') v LOOP
    member_uuid:=(entry->>'memberId')::uuid; birthday_value:=(entry->>'birthdayDate')::date; year_value:=extract(year FROM birthday_value)::integer;
    IF NOT EXISTS(SELECT 1 FROM target_private.birthday_receipts WHERE member_id=member_uuid AND gift_year=year_value) THEN
      granted:=granted+1; bytes_value:=bytes_value+256;
    END IF;
  END LOOP;
  SELECT count(DISTINCT (v->>'memberId')::uuid)::integer INTO profile_count FROM jsonb_array_elements(p_input->'gifts') v
    WHERE NOT EXISTS(SELECT 1 FROM target_private.profiles p WHERE p.member_id=(v->>'memberId')::uuid);
  bytes_value:=bytes_value+profile_count*256;
  IF (SELECT count(*) FROM target_private.profiles)+profile_count>500 OR
      (SELECT logical_bytes FROM target_private.system_state WHERE singleton)>104857600-bytes_value THEN
    RETURN target_private.error_result(507,'CAPACITY_LIMIT','保存容量の上限に達しました。'); END IF;
  IF EXISTS(SELECT 1 FROM (SELECT (v->>'memberId')::uuid AS id,sum(CASE WHEN (v->>'birthdayDate')::date >= DATE '2026-11-11' THEN 1000000 ELSE 100000 END)::bigint AS amount
    FROM jsonb_array_elements(p_input->'gifts') v WHERE NOT EXISTS(SELECT 1 FROM target_private.birthday_receipts r
      WHERE r.member_id=(v->>'memberId')::uuid AND r.gift_year=extract(year FROM (v->>'birthdayDate')::date)::integer)
    GROUP BY (v->>'memberId')::uuid) credits LEFT JOIN target_private.profiles p ON p.member_id=credits.id
    WHERE coalesce(p.total_points,0)>10000000000000-credits.amount) THEN
    RETURN target_private.error_result(507,'INCOME_LIMIT','総取得の上限に達しました。'); END IF;
  FOR entry IN SELECT v FROM jsonb_array_elements(p_input->'gifts') v LOOP
    member_uuid:=(entry->>'memberId')::uuid; birthday_value:=(entry->>'birthdayDate')::date; year_value:=extract(year FROM birthday_value)::integer;
    IF EXISTS(SELECT 1 FROM target_private.birthday_receipts WHERE member_id=member_uuid AND gift_year=year_value) THEN CONTINUE; END IF;
    display_name:=btrim(entry->>'name');
    INSERT INTO target_private.profiles(member_id,name) VALUES(member_uuid,display_name) ON CONFLICT(member_id) DO UPDATE SET name=excluded.name;
    gift_amount:=CASE WHEN birthday_value>=DATE '2026-11-11' THEN 1000000 ELSE 100000 END;
    INSERT INTO target_private.birthday_receipts(member_id,gift_year,birthday_date,amount)
      VALUES(member_uuid,year_value,birthday_value,gift_amount);
    UPDATE target_private.profiles SET total_points=total_points+gift_amount,birthday_points=birthday_points+gift_amount,updated_at=now() WHERE member_id=member_uuid;
  END LOOP;
  UPDATE target_private.system_state SET logical_bytes=logical_bytes+bytes_value WHERE singleton;
  RETURN jsonb_build_object('granted',granted);
END $function$;

CREATE OR REPLACE FUNCTION target_private.wallet_finance_projection(p_cutoff timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(member_id uuid, total_points bigint, spent_points bigint, calculus_points bigint, birthday_points bigint, casino_net bigint, calculus_forgiven_points bigint, raw_study_points bigint, map_spent bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 WITH study AS(SELECT a.member_id,sum(a.award_points)::bigint amount FROM target_private.answers a
   WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 calculus AS(SELECT a.member_id,sum(a.amount)::bigint amount FROM target_private.calculus_credits a
   WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 voids AS(SELECT a.member_id,sum(a.amount)::bigint amount,sum(a.forgiven_amount)::bigint forgiven
   FROM target_private.calculus_void_receipts a WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 recoveries AS(SELECT a.member_id,sum(a.calculus_delta)::bigint calculus,sum(a.forgiven_delta)::bigint forgiven
   FROM target_private.external_calculus_recovery_deltas(p_cutoff) a GROUP BY a.member_id),
 gifts AS(SELECT a.member_id,sum(a.amount)::bigint amount FROM (
   SELECT member_id,amount,created_at FROM target_private.birthday_receipts
   UNION ALL SELECT member_id,amount,created_at FROM target_private.birthday_upgrades
 ) a WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 games AS(SELECT a.member_id,sum(a.net)::bigint amount FROM (SELECT member_id,net,created_at FROM target_private.casino_rounds UNION ALL SELECT member_id,delta,created_at FROM target_private.two_player_wallet_events) a
   WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 spending AS(SELECT a.member_id,sum(a.cost)::bigint amount,sum(a.cost) FILTER(WHERE a.map_cost)::bigint map_amount FROM(
     SELECT member_id,cost,created_at,false map_cost FROM target_private.sticker_draws
     UNION ALL SELECT member_id,cost,created_at,false FROM target_private.item_draws
     UNION ALL SELECT member_id,cost,created_at,true FROM target_private.map_purchases
     UNION ALL SELECT member_id,cost,created_at,true FROM target_private.territory_orders) a
   WHERE p_cutoff IS NULL OR a.created_at<p_cutoff GROUP BY a.member_id),
 corrections AS(SELECT a.member_id,sum((a.component_deltas->>'rawStudyPoints')::bigint)::bigint study,
     sum((a.component_deltas->>'calculusPoints')::bigint)::bigint calculus,
     sum((a.component_deltas->>'birthdayPoints')::bigint)::bigint birthday,
     sum((a.component_deltas->>'casinoNet')::bigint)::bigint casino,
     sum((a.component_deltas->>'calculusForgivenPoints')::bigint)::bigint forgiven,
     sum((a.component_deltas->>'spentPoints')::bigint)::bigint spent
   FROM target_private.wallet_restorations a JOIN target_private.wallet_restoration_events e USING(reset_id)
   WHERE p_cutoff IS NULL OR e.created_at<p_cutoff GROUP BY a.member_id),
 components AS(SELECT p.member_id,coalesce(s.amount,0)+coalesce(r.study,0) study,
     coalesce(c.amount,0)+coalesce(v.amount,0)+coalesce(z.calculus,0)+coalesce(r.calculus,0) calculus,
     coalesce(b.amount,0)+coalesce(r.birthday,0) birthday,coalesce(g.amount,0)+coalesce(r.casino,0) casino,
     coalesce(v.forgiven,0)+coalesce(z.forgiven,0)+coalesce(r.forgiven,0) forgiven,
     coalesce(x.amount,0)+coalesce(r.spent,0)-coalesce((SELECT sum(i.additional_refund) FROM target_private.inventory_voids i WHERE i.member_id=p.member_id AND (p_cutoff IS NULL OR i.created_at<p_cutoff)),0)-coalesce((SELECT sum(b.amount) FROM target_private.duplicate_rebates b WHERE b.member_id=p.member_id AND (p_cutoff IS NULL OR b.credited_at<p_cutoff)),0) spent,coalesce(x.map_amount,0) map_spent
   FROM target_private.profiles p LEFT JOIN study s USING(member_id) LEFT JOIN calculus c USING(member_id)
     LEFT JOIN voids v USING(member_id) LEFT JOIN recoveries z USING(member_id)
     LEFT JOIN gifts b USING(member_id) LEFT JOIN games g USING(member_id)
     LEFT JOIN spending x USING(member_id) LEFT JOIN corrections r USING(member_id))
 SELECT member_id,study+calculus+birthday+casino+forgiven,spent,calculus,birthday,casino,forgiven,study,map_spent FROM components;
$function$;

-- Credit old already-issued same-day receipts once, retaining the original
-- seen/amount metadata. A single advisory lock covers gift RPC and adjustment.
DO $topup$
DECLARE gift record;
BEGIN
 FOR gift IN SELECT r.member_id,r.gift_year
   FROM target_private.birthday_receipts r
   WHERE r.birthday_date >= DATE '2026-11-11' AND r.amount=100000
     AND NOT EXISTS(SELECT 1 FROM target_private.birthday_upgrades u
       WHERE u.member_id=r.member_id AND u.gift_year=r.gift_year)
   ORDER BY r.birthday_date,r.member_id
 LOOP
   IF EXISTS(SELECT 1 FROM target_private.profiles p WHERE p.member_id=gift.member_id
       AND p.total_points>10000000000000-900000)
     OR (SELECT logical_bytes FROM target_private.system_state WHERE singleton)>104857600-256 THEN
     RAISE EXCEPTION 'Birthday upgrade exceeds financial or storage limits';
   END IF;
   INSERT INTO target_private.birthday_upgrades(member_id,gift_year,amount)
     VALUES(gift.member_id,gift.gift_year,900000) ON CONFLICT DO NOTHING;
   IF FOUND THEN
     UPDATE target_private.profiles SET total_points=total_points+900000,
       birthday_points=birthday_points+900000,updated_at=now() WHERE member_id=gift.member_id;
     UPDATE target_private.system_state SET logical_bytes=logical_bytes+256 WHERE singleton;
   END IF;
 END LOOP;
END $topup$;
