-- Audited positive compensation for a previously applied calculus correction.
-- This installs support only. It contains no live account IDs or refund call.
begin;
select pg_advisory_xact_lock(991101);

do $preflight$
begin
  if md5(pg_get_functiondef('public.target_calculus_rpc(text,text,jsonb)'::regprocedure)) <> '6292b0b68376a02197ad37733bd742ab'
     or md5(pg_get_functiondef('target_private.calculus_status(integer)'::regprocedure)) <> '91a16d65a23b62943377ef5beb72996a'
     or md5(pg_get_functiondef('target_private.protect_calculus_history()'::regprocedure)) <> '4301f8aea6172e5b69d5109807e13ce5'
     or md5(pg_get_functiondef('target_private.advance_wallet_revision()'::regprocedure)) <> 'bbb59c21e81b84e73eac9496c61f4b94' then
    raise exception 'Target wallet definitions changed; review restoration support';
  end if;
  if to_regclass('target_private.calculus_void_receipts') is null
     or not exists(select 1 from pg_attribute where attrelid='target_private.profiles'::regclass
       and attname='calculus_forgiven_points' and not attisdropped) then
    raise exception 'Calculus correction support is not installed';
  end if;
end;
$preflight$;

create table target_private.calculus_void_restorations (
  restoration_id text primary key check(restoration_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  original_reset_id text not null,
  user_id integer not null check(user_id>0),
  original_source_from bigint not null,
  original_source_to bigint not null,
  original_applied_through bigint not null,
  restored_from bigint not null check(restored_from between 0 and 999999999),
  restored_to bigint not null check(restored_to between 1 and 1000000000 and restored_to>restored_from),
  member_id uuid not null references target_private.profiles(member_id),
  amount bigint not null check(amount=(restored_to-restored_from)*10000 and amount>0),
  cash_refunded bigint not null check(cash_refunded between 0 and amount and cash_refunded%10=0),
  forgiveness_reversed bigint not null check(forgiveness_reversed=amount-cash_refunded and forgiveness_reversed%10=0),
  cash_allocation text not null default 'latest_source_points_cash_first'
    check(cash_allocation='latest_source_points_cash_first'),
  source_boundary timestamptz not null check(isfinite(source_boundary)),
  manifest_sha256 text not null check(manifest_sha256 ~ '^[0-9a-f]{64}$'),
  wallet_revision_before bigint not null check(wallet_revision_before between 0 and 9999999999999),
  wallet_revision_after bigint not null check(wallet_revision_after=wallet_revision_before+1),
  created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
  foreign key(original_reset_id,user_id,original_source_from,original_source_to,original_applied_through)
    references target_private.calculus_void_receipts(reset_id,user_id,source_from,source_to,applied_through),
  check(original_source_from<=restored_from and restored_to<=original_applied_through
    and original_applied_through<=original_source_to)
);
create index calculus_void_restorations_source on target_private.calculus_void_restorations(user_id,restored_from,restored_to);
alter table target_private.calculus_void_restorations enable row level security;
revoke all on target_private.calculus_void_restorations from public,anon,authenticated;
create trigger calculus_void_restoration_permanent before update or delete on target_private.calculus_void_restorations
  for each row execute function target_private.protect_calculus_void_history();
create trigger calculus_void_restoration_storage after insert on target_private.calculus_void_restorations
  for each row execute function target_private.calculus_void_storage();

create function target_private.restore_calculus_void(
  p_restoration_id text,
  p_original_reset_id text,
  p_user_id integer,
  p_original_source_from bigint,
  p_original_source_to bigint,
  p_original_applied_through bigint,
  p_restored_from bigint,
  p_restored_to bigint,
  p_source_boundary timestamptz,
  p_manifest_sha256 text
) returns jsonb language plpgsql set search_path=pg_catalog as $restore$
declare
  v_original target_private.calculus_void_receipts%rowtype;
  v_saved target_private.calculus_void_restorations%rowtype;
  v_link target_private.calculus_links%rowtype;
  v_profile target_private.profiles%rowtype;
  v_amount bigint; v_cash bigint; v_unforgive bigint;
begin
  if p_restoration_id is null or p_restoration_id !~ '^[a-zA-Z0-9_-]{1,80}$'
     or p_original_reset_id is null or p_user_id is null or p_user_id<=0
     or p_original_source_from is null or p_original_source_to is null
     or p_original_applied_through is null or p_restored_from is null or p_restored_to is null
     or p_restored_from<0 or p_restored_to>1000000000 or p_restored_to<=p_restored_from
     or p_source_boundary is null or not isfinite(p_source_boundary)
     or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid calculus restoration request' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(991101);
  select * into v_saved from target_private.calculus_void_restorations where restoration_id=p_restoration_id;
  if found then
    if (v_saved.original_reset_id,v_saved.user_id,v_saved.original_source_from,v_saved.original_source_to,
        v_saved.original_applied_through,v_saved.restored_from,v_saved.restored_to,v_saved.source_boundary,v_saved.manifest_sha256)
       is distinct from
       (p_original_reset_id,p_user_id,p_original_source_from,p_original_source_to,
        p_original_applied_through,p_restored_from,p_restored_to,p_source_boundary,p_manifest_sha256) then
      raise exception 'Restoration ID already has different contents' using errcode='23505';
    end if;
    return jsonb_build_object('applied',false,'receipt',to_jsonb(v_saved));
  end if;
  select * into v_original from target_private.calculus_void_receipts
    where reset_id=p_original_reset_id and user_id=p_user_id and source_from=p_original_source_from
      and source_to=p_original_source_to and applied_through=p_original_applied_through;
  if not found then raise exception 'Original calculus correction receipt not found' using errcode='22023'; end if;
  if p_restored_from<v_original.previous_applied_through or p_restored_to>v_original.applied_through then
    raise exception 'Restoration interval was not applied by this receipt' using errcode='22023';
  end if;
  if exists(select 1 from target_private.calculus_void_restorations r
      where r.user_id=p_user_id and r.restored_from<p_restored_to and p_restored_from<r.restored_to) then
    raise exception 'Overlapping calculus restoration interval' using errcode='22023';
  end if;
  select * into v_link from target_private.calculus_links where user_id=p_user_id for update;
  if not found or v_link.member_id<>v_original.member_id
      or v_link.imported_source_points<v_original.applied_through then
    raise exception 'Original calculus account mapping does not match' using errcode='23514';
  end if;
  select * into strict v_profile from target_private.profiles where member_id=v_link.member_id for update;
  v_amount:=(p_restored_to-p_restored_from)*10000;
  -- Original collected cash is assigned to the latest source points first.
  -- This is interval intersection in currency coordinates, including 10-unit
  -- cash boundaries inside an individual 10,000-unit source point.
  v_cash:=greatest(0,
    least(p_restored_to*10000,v_original.applied_through*10000)
    -greatest(p_restored_from*10000,v_original.applied_through*10000-v_original.balance_removed));
  v_unforgive:=v_amount-v_cash;
  if v_profile.calculus_forgiven_points<v_unforgive then
    raise exception 'Forgiven calculus balance does not cover restoration' using errcode='23514';
  end if;
  if v_profile.calculus_points>10000000000000-v_amount
      or v_profile.total_points>10000000000000-v_cash
      or v_profile.wallet_revision>=10000000000000 then
    raise exception 'Restoration exceeds wallet limits' using errcode='54000';
  end if;
  -- Delta update: preserve all subsequent income, purchases and game results.
  -- Mention total_points even when v_cash=0, preserving one revision advance.
  update target_private.profiles set calculus_points=calculus_points+v_amount,
    total_points=total_points+v_cash,
    calculus_forgiven_points=calculus_forgiven_points-v_unforgive,
    updated_at=now() where member_id=v_link.member_id;
  insert into target_private.calculus_void_restorations(restoration_id,original_reset_id,user_id,
    original_source_from,original_source_to,original_applied_through,restored_from,restored_to,
    member_id,amount,cash_refunded,forgiveness_reversed,source_boundary,manifest_sha256,
    wallet_revision_before,wallet_revision_after)
  values(p_restoration_id,p_original_reset_id,p_user_id,p_original_source_from,p_original_source_to,
    p_original_applied_through,p_restored_from,p_restored_to,v_link.member_id,v_amount,v_cash,v_unforgive,
    p_source_boundary,p_manifest_sha256,v_profile.wallet_revision,v_profile.wallet_revision+1)
  returning * into v_saved;
  return jsonb_build_object('applied',true,'receipt',to_jsonb(v_saved));
end;
$restore$;
revoke all on function target_private.restore_calculus_void(text,text,integer,bigint,bigint,bigint,bigint,bigint,timestamptz,text)
  from public,anon,authenticated;
do $service_acl$
begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on target_private.calculus_void_restorations from service_role;
    revoke all on function target_private.restore_calculus_void(text,text,integer,bigint,bigint,bigint,bigint,bigint,timestamptz,text) from service_role;
  end if;
end;
$service_acl$;
commit;
