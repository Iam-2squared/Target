-- Read-only metadata and aggregate checks. No names, account IDs, credentials,
-- rate allocations, new seasons, purchases or balance changes are produced.
-- This is one combined SELECT so MCP transports retain every verification.
WITH current_season AS (
  SELECT * FROM target_private.territory_seasons
  WHERE starts_at=(date_trunc('week',clock_timestamp() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo')
), board AS (
  SELECT t.* FROM target_private.territory_tiles t JOIN current_season s ON s.id=t.season_id
)
SELECT jsonb_build_object(
  'currentSeason',(SELECT jsonb_build_object('id',to_char(starts_at AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD'),'startsAt',starts_at,'endsAt',ends_at,'revision',revision) FROM current_season),
  'board',(SELECT jsonb_build_object('tiles',count(*),'reservedHomes',count(*) FILTER(WHERE kind=1),'castles',count(*) FILTER(WHERE kind=2),
    'reservedHomesValid',NOT EXISTS(SELECT 1 FROM board h WHERE h.kind=1 AND (h.x<>3+(h.hq_slot-1)%8*6 OR h.y<>5+(h.hq_slot-1)/8*10 OR (h.owner_slot IS NOT NULL AND h.owner_slot<>h.hq_slot))),
    'initialNeutralCastleGuards',count(*) FILTER(WHERE kind=2 AND owner_slot IS NULL AND troops=8),
    'ownerTroopsValid',bool_and((owner_slot IS NULL OR troops>=1) AND (owner_slot IS NOT NULL OR troops=0 OR (kind=2 AND troops BETWEEN 0 AND 8)))) FROM board),
  'players',(SELECT jsonb_build_object('currentCount',count(*),'boundedTo40',count(*)<=40,'uniqueSlots',count(*)=count(DISTINCT slot),'validSlots',coalesce(bool_and(slot BETWEEN 1 AND 40),true)) FROM target_private.territory_players p JOIN current_season s ON s.id=p.season_id),
  'oldPaintLedger',(SELECT jsonb_build_object('cells',(SELECT count(*) FROM target_private.map_cells),'receipts',count(*),'spent',coalesce(sum(cost),0)) FROM target_private.map_purchases),
  'spendingInvariant',NOT EXISTS(
    SELECT 1 FROM target_private.profiles p WHERE p.spent_points<>
      coalesce((SELECT sum(cost) FROM target_private.sticker_draws WHERE member_id=p.member_id),0)+
      coalesce((SELECT sum(cost) FROM target_private.item_draws WHERE member_id=p.member_id),0)+
      coalesce((SELECT sum(cost) FROM target_private.map_purchases WHERE member_id=p.member_id),0)+
      coalesce((SELECT sum(cost) FROM target_private.territory_orders WHERE member_id=p.member_id),0)),
  'privateTables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,'noClientPrivileges',NOT EXISTS(
    SELECT 1 FROM pg_roles r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
    WHERE r.rolname IN ('anon','authenticated','service_role') AND has_table_privilege(r.oid,c.oid,privilege))) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relname IN ('territory_seasons','territory_players','territory_tiles','territory_orders')),
  'privateFunctions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'securityDefiner',p.prosecdef,'settings',p.proconfig,'noClientExecution',NOT EXISTS(
    SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role') AND has_function_privilege(r.oid,p.oid,'EXECUTE'))) ORDER BY p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='target_private' AND (p.proname LIKE 'territory_%' OR p.proname='retired_paint_map_rpc')),
  'entryPoint',(SELECT jsonb_build_object('securityDefiner',prosecdef,'settings',proconfig,'anonExecute',has_function_privilege('anon',oid,'EXECUTE'),'authenticatedExecute',has_function_privilege('authenticated',oid,'EXECUTE')) FROM pg_proc WHERE oid='public.target_territory_rpc(text,text,jsonb)'::regprocedure),
  'invalidSecret',public.target_territory_rpc('','state','{}'::jsonb),
  'oldWriteGate',jsonb_build_object('secretStillRequired',public.target_map_rpc('','buy','{}'::jsonb),'retiredSourceHash',(SELECT md5(replace(pg_get_functiondef(oid),'CREATE OR REPLACE FUNCTION target_private.retired_paint_map_rpc','CREATE OR REPLACE FUNCTION public.target_map_rpc')) FROM pg_proc WHERE oid='target_private.retired_paint_map_rpc(text,text,jsonb)'::regprocedure)),
  'existingFunctionHashes',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'hash',md5(pg_get_functiondef(p.oid)),'acl',p.proacl,'settings',p.proconfig,'securityDefiner',p.prosecdef) ORDER BY n.nspname,p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='public' AND p.proname IN ('target_rpc','target_shop_rpc')) OR
      (n.nspname='target_private' AND p.proname IN ('reward_points_for_roll','bonus_snapshot','record_word_mastery','enforce_gacha_catalog_protocol','enforce_gacha_price_protocol','wallet_snapshot','map_wallet_snapshot'))),
  'immutableReceiptTrigger',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.territory_orders'::regclass AND tgname='target_territory_order_immutable' AND tgenabled='O'),
  'spentConstraint',(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='target_wallet_spent_bounds' AND conrelid='target_private.profiles'::regclass)
) AS verification;
