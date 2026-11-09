-- Administrative correction support. No reset manifest is embedded here.
-- Policy B: collect only the available balance and permanently forgive the rest.
-- Existing gross import receipts and high-watermarks remain permanent.
begin;
select pg_advisory_xact_lock(991101);

do $preflight$
begin
  if md5(pg_get_functiondef('public.target_calculus_rpc(text,text,jsonb)'::regprocedure)) <> '6292b0b68376a02197ad37733bd742ab'
     or md5(pg_get_functiondef('target_private.calculus_status(integer)'::regprocedure)) <> '91a16d65a23b62943377ef5beb72996a'
     or md5(pg_get_functiondef('target_private.protect_calculus_history()'::regprocedure)) <> '4301f8aea6172e5b69d5109807e13ce5'
     or md5(pg_get_functiondef('target_private.advance_wallet_revision()'::regprocedure)) <> 'bbb59c21e81b84e73eac9496c61f4b94' then
    raise exception 'Target wallet definitions changed; review before migration';
  end if;
  if exists(select 1 from pg_attribute where attrelid='target_private.profiles'::regclass
      and attname='calculus_forgiven_points' and not attisdropped) then
    raise exception 'Calculus correction migration is already installed';
  end if;
  if (select md5(pg_get_constraintdef(oid)) from pg_constraint
      where conrelid='target_private.profiles'::regclass and conname='target_games_income_bounds')
      is distinct from 'f2307e517360bad66ce32f56f602590b' then
    raise exception 'Target income constraint changed; review before migration';
  end if;
end;
$preflight$;

-- The old RPC reserves its own bytes before AFTER triggers run. This upper
-- check also covers its final increment, so combined accounting cannot commit
-- above the already-established 100 MiB capacity contract.
alter table target_private.system_state add constraint calculus_correction_storage_cap
  check(logical_bytes<=104857600);

alter table target_private.profiles
  add column calculus_forgiven_points bigint not null default 0
    check(calculus_forgiven_points between 0 and 10000000000000 and calculus_forgiven_points%10=0);
alter table target_private.profiles drop constraint target_games_income_bounds;
alter table target_private.profiles add constraint target_games_income_bounds check(
  total_points between 0 and 10000000000000 and total_points%10=0
  and calculus_points between 0 and 10000000000000 and calculus_points%10000=0
  and birthday_points between 0 and 20000000000000 and birthday_points%100000=0
  and casino_net between -10000000000000 and 10000000000000 and casino_net%10=0
  and total_points-calculus_points-birthday_points-casino_net-calculus_forgiven_points
    between 0 and correct_count*100000
  and (total_points-calculus_points-birthday_points-casino_net-calculus_forgiven_points)%100=0
);

create table target_private.calculus_void_events (
  reset_id text primary key check(reset_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  source_day date not null,
  source_cutoff timestamptz not null check(isfinite(source_cutoff)),
  manifest_sha256 text not null check(manifest_sha256 ~ '^[0-9a-f]{64}$'),
  policy text not null default 'available_balance_forgive'
    check(policy='available_balance_forgive'),
  created_at timestamptz not null default clock_timestamp() check(isfinite(created_at))
);
create table target_private.calculus_void_ranges (
  reset_id text not null references target_private.calculus_void_events(reset_id),
  user_id integer not null check(user_id>0),
  source_from bigint not null check(source_from between 0 and 999999999),
  source_to bigint not null check(source_to between 1 and 1000000000 and source_to>source_from),
  primary key(reset_id,user_id,source_from,source_to)
);
create index calculus_void_ranges_source on target_private.calculus_void_ranges(user_id,source_from,source_to);
create table target_private.calculus_void_receipts (
  reset_id text not null,
  user_id integer not null,
  source_from bigint not null,
  source_to bigint not null,
  previous_applied_through bigint not null,
  applied_through bigint not null,
  imported_source_points bigint not null check(imported_source_points between 0 and 1000000000),
  member_id uuid not null references target_private.profiles(member_id),
  amount bigint not null check(amount<0 and amount=-(applied_through-previous_applied_through)*10000),
  balance_removed bigint not null check(balance_removed between 0 and -amount and balance_removed%10=0),
  forgiven_amount bigint not null check(forgiven_amount=-amount-balance_removed and forgiven_amount%10=0),
  wallet_revision_before bigint not null check(wallet_revision_before between 0 and 9999999999999),
  wallet_revision_after bigint not null check(wallet_revision_after=wallet_revision_before+1),
  created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
  primary key(reset_id,user_id,source_from,source_to,applied_through),
  foreign key(reset_id,user_id,source_from,source_to)
    references target_private.calculus_void_ranges(reset_id,user_id,source_from,source_to),
  check(source_from<=previous_applied_through and previous_applied_through<applied_through
    and applied_through<=source_to and applied_through<=imported_source_points)
);

alter table target_private.calculus_void_events enable row level security;
alter table target_private.calculus_void_ranges enable row level security;
alter table target_private.calculus_void_receipts enable row level security;
revoke all on target_private.calculus_void_events,target_private.calculus_void_ranges,
  target_private.calculus_void_receipts from public,anon,authenticated;

create function target_private.protect_calculus_void_history()
returns trigger language plpgsql set search_path=pg_catalog as $immutable$
begin
  raise exception 'Calculus correction records are permanent' using errcode='42501';
end;
$immutable$;
create trigger calculus_void_event_permanent before update or delete on target_private.calculus_void_events
  for each row execute function target_private.protect_calculus_void_history();
create trigger calculus_void_range_permanent before update or delete on target_private.calculus_void_ranges
  for each row execute function target_private.protect_calculus_void_history();
create trigger calculus_void_receipt_permanent before update or delete on target_private.calculus_void_receipts
  for each row execute function target_private.protect_calculus_void_history();

create function target_private.calculus_void_storage()
returns trigger language plpgsql set search_path=pg_catalog as $storage$
declare v_bytes bigint;
begin
  v_bytes:=case tg_table_name when 'calculus_void_events' then 512 when 'calculus_void_ranges' then 256 else 512 end;
  update target_private.system_state set logical_bytes=logical_bytes+v_bytes
    where singleton and logical_bytes<=104857600-v_bytes;
  if not found then raise exception 'Calculus correction storage limit reached' using errcode='54000'; end if;
  return new;
end;
$storage$;
create trigger calculus_void_event_storage after insert on target_private.calculus_void_events
  for each row execute function target_private.calculus_void_storage();
create trigger calculus_void_range_storage after insert on target_private.calculus_void_ranges
  for each row execute function target_private.calculus_void_storage();
create trigger calculus_void_receipt_storage after insert on target_private.calculus_void_receipts
  for each row execute function target_private.calculus_void_storage();

create function target_private.validate_calculus_void_range()
returns trigger language plpgsql set search_path=pg_catalog as $range_guard$
begin
  perform pg_advisory_xact_lock(991101);
  if exists(select 1 from target_private.calculus_void_ranges r where r.user_id=new.user_id
      and r.source_from<new.source_to and new.source_from<r.source_to
      and (r.reset_id,r.source_from,r.source_to)<>(new.reset_id,new.source_from,new.source_to)) then
    raise exception 'Overlapping calculus correction interval' using errcode='22023';
  end if;
  return new;
end;
$range_guard$;
create trigger calculus_void_range_valid before insert on target_private.calculus_void_ranges
  for each row execute function target_private.validate_calculus_void_range();

create function target_private.apply_calculus_voids(p_user_id integer)
returns void language plpgsql set search_path=pg_catalog as $apply_voids$
declare
  v_link target_private.calculus_links%rowtype;
  v_profile target_private.profiles%rowtype;
  v_range target_private.calculus_void_ranges%rowtype;
  v_previous bigint; v_through bigint; v_amount bigint; v_remove bigint;
begin
  -- Same lock order as Target's public ledger RPC: global -> source link -> wallet.
  perform pg_advisory_xact_lock(991101);
  select * into v_link from target_private.calculus_links where user_id=p_user_id for update;
  if not found then return; end if;
  select * into strict v_profile from target_private.profiles where member_id=v_link.member_id for update;
  for v_range in select * from target_private.calculus_void_ranges where user_id=p_user_id
      order by source_from,source_to,reset_id loop
    select coalesce(max(applied_through),v_range.source_from) into v_previous
      from target_private.calculus_void_receipts
      where reset_id=v_range.reset_id and user_id=p_user_id
        and source_from=v_range.source_from and source_to=v_range.source_to;
    v_through:=greatest(v_range.source_from,least(v_link.imported_source_points,v_range.source_to));
    if v_through<=v_previous then continue; end if;
    v_amount:=(v_through-v_previous)*10000;
    if v_profile.calculus_points<v_amount then
      raise exception 'Calculus income does not cover the imported correction' using errcode='23514';
    end if;
    if v_profile.wallet_revision>=10000000000000 then
      raise exception 'Wallet revision limit reached' using errcode='54000';
    end if;
    v_remove:=least(v_profile.total_points-v_profile.spent_points,v_amount);
    -- The waived amount is explicit, permanent accounting. It is not a debt.
    update target_private.profiles set
      calculus_points=calculus_points-v_amount,
      total_points=total_points-v_remove,
      calculus_forgiven_points=calculus_forgiven_points+v_amount-v_remove,
      updated_at=now()
      where member_id=v_link.member_id;
    insert into target_private.calculus_void_receipts(reset_id,user_id,source_from,source_to,
      previous_applied_through,applied_through,imported_source_points,member_id,amount,
      balance_removed,forgiven_amount,wallet_revision_before,wallet_revision_after)
    values(v_range.reset_id,p_user_id,v_range.source_from,v_range.source_to,v_previous,v_through,
      v_link.imported_source_points,v_link.member_id,-v_amount,v_remove,v_amount-v_remove,
      v_profile.wallet_revision,v_profile.wallet_revision+1);
    select * into strict v_profile from target_private.profiles where member_id=v_link.member_id;
  end loop;
end;
$apply_voids$;

create function target_private.apply_calculus_void_range()
returns trigger language plpgsql set search_path=pg_catalog as $apply_range$
begin
  perform target_private.apply_calculus_voids(new.user_id);
  return new;
end;
$apply_range$;
create trigger calculus_void_apply_existing after insert on target_private.calculus_void_ranges
  for each row execute function target_private.apply_calculus_void_range();

create function target_private.apply_calculus_void_import()
returns trigger language plpgsql set search_path=pg_catalog as $apply_import$
begin
  perform target_private.apply_calculus_voids(new.user_id);
  return new;
end;
$apply_import$;
create trigger calculus_void_apply_import after insert or update of imported_source_points on target_private.calculus_links
  for each row execute function target_private.apply_calculus_void_import();

revoke all on function target_private.protect_calculus_void_history(),target_private.calculus_void_storage(),
  target_private.validate_calculus_void_range(),target_private.apply_calculus_voids(integer),
  target_private.apply_calculus_void_range(),target_private.apply_calculus_void_import()
  from public,anon,authenticated;
do $service_acl$
begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on target_private.calculus_void_events,target_private.calculus_void_ranges,
      target_private.calculus_void_receipts from service_role;
    revoke all on function target_private.protect_calculus_void_history(),target_private.calculus_void_storage(),
      target_private.validate_calculus_void_range(),target_private.apply_calculus_voids(integer),
      target_private.apply_calculus_void_range(),target_private.apply_calculus_void_import() from service_role;
  end if;
end;
$service_acl$;

-- Public RPC/status/legacy receipt protection/revision functions are intentionally
-- unchanged. The import AFTER trigger runs after gross credit, before its RPC's
-- final snapshot/COMMIT, and range insertion settles already-linked wallets.
commit;
