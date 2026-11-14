-- Run as the migration administrator after applying the shared-map migration.
-- No real user writes, no secret reads, no personal identifiers in output.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='15s';

-- Expect four tables, RLS enabled, no policies, no direct client-role privileges.
SELECT c.relname AS table_name,c.relrowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policy_count,
  NOT EXISTS (
    SELECT 1 FROM pg_roles r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
    WHERE r.rolname IN ('anon','authenticated','service_role') AND has_table_privilege(r.oid,c.oid,privilege)
  ) AS no_direct_client_access
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='target_private' AND c.relname IN ('map_state','map_rows','map_cells','map_purchases')
ORDER BY c.relname;

-- Expect one state row and 500 valid raster rows. New installation is revision 0,
-- 0 cells, 0 receipts, 0 nonzero raster bytes. After use, only the validity flags
-- and row counts stay fixed; existing cells/receipts are left untouched.
SELECT
  (SELECT count(*) FROM target_private.map_state) AS state_rows,
  (SELECT revision FROM target_private.map_state WHERE singleton) AS revision,
  count(*) AS raster_rows,min(y)=0 AND max(y)=499 AND count(DISTINCT y)=500 AS complete_rows,
  bool_and(octet_length(pixels)=500) AS row_lengths_valid,
  sum(octet_length(pixels)) AS total_raster_bytes,
  (SELECT count(*) FROM target_private.map_cells) AS purchased_cells,
  (SELECT count(*) FROM target_private.map_purchases) AS immutable_receipts,
  NOT EXISTS (
    SELECT 1 FROM target_private.map_rows r CROSS JOIN generate_series(0,499) i
    WHERE get_byte(r.pixels,i) NOT BETWEEN 0 AND 8
  ) AS palette_bytes_valid
FROM target_private.map_rows;

-- Expect coordinate/ownership image agreement and exact historical price math.
SELECT
  NOT EXISTS (
    SELECT 1 FROM target_private.map_cells c JOIN target_private.map_rows r ON r.y=c.y
    WHERE get_byte(r.pixels,c.x)<>c.color
  ) AS occupied_raster_matches,
  NOT EXISTS (
    SELECT 1 FROM target_private.map_rows r CROSS JOIN generate_series(0,499) i
    LEFT JOIN target_private.map_cells c ON c.x=i AND c.y=r.y
    WHERE c.x IS NULL AND get_byte(r.pixels,i)<>0
  ) AS empty_raster_matches,
  NOT EXISTS (
    SELECT 1 FROM target_private.map_purchases
    WHERE cost<>new_count*100+takeover_count*1000 OR new_count+takeover_count>cell_count
  ) AS receipt_prices_valid,
  EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.map_purchases'::regclass
      AND tgname='target_map_receipt_immutable' AND tgenabled='O'
  ) AS immutable_trigger_active;

-- Expect all true. These pure geometry calls allocate no profile or ledger data.
SELECT
  (SELECT count(*) FROM target_private.map_selection('{"type":"cell","x":499,"y":499}'))=1 AS edge_cell,
  (SELECT count(*) FROM target_private.map_selection('{"type":"line","x1":0,"y1":499,"x2":499,"y2":0}'))=500 AS full_diagonal,
  (SELECT count(*) FROM target_private.map_selection('{"type":"line","x1":499,"y1":0,"x2":0,"y2":0}'))=500 AS reverse_line,
  (SELECT count(*) FROM target_private.map_selection('{"type":"square","x":495,"y":495,"size":5}'))=25 AS edge_square,
  (SELECT count(*) FROM target_private.map_selection('{"type":"square","x":0,"y":0,"size":500}'))=250000 AS full_square;

-- Expect one public SECURITY DEFINER entry point with scoped timeout/search_path.
-- anon may execute only the gated public function; private helpers deny all
-- client roles. This does not invoke the RPC or consume a rate-limit allowance.
SELECT p.oid::regprocedure::text AS signature,p.prosecdef AS security_definer,
  p.proconfig AS settings,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute
FROM pg_proc p WHERE p.oid='public.target_map_rpc(text,text,jsonb)'::regprocedure;
SELECT p.oid::regprocedure::text AS signature,
  NOT EXISTS (
    SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
      AND has_function_privilege(r.oid,p.oid,'EXECUTE')
  ) AS no_direct_client_execution
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='target_private' AND p.proname IN ('map_normalize_shape','map_selection','map_wallet_snapshot','map_snapshot','map_quote')
ORDER BY signature;

-- Expect spent bounds retain >=0, <=income, and modulo100; receipt CHECK uses
-- both new_count*100 and takeover_count*1000.
SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
WHERE conname='target_wallet_spent_bounds'
  OR (conrelid='target_private.map_purchases'::regclass AND contype='c')
ORDER BY conname;

-- Compare these hashes to the preflight baseline: every row must be identical.
SELECT p.oid::regprocedure::text AS signature,md5(pg_get_functiondef(p.oid)) AS hash
FROM pg_proc p WHERE p.oid IN (
  'public.target_rpc(text,text,jsonb)'::regprocedure,
  'public.target_shop_rpc(text,text,jsonb)'::regprocedure,
  'target_private.reward_points_for_roll(integer)'::regprocedure,
  'target_private.bonus_snapshot(uuid)'::regprocedure,
  'target_private.record_word_mastery()'::regprocedure,
  'target_private.enforce_gacha_catalog_protocol()'::regprocedure,
  'target_private.enforce_gacha_price_protocol()'::regprocedure
) ORDER BY signature;

-- The wallet function alone gains mapSpent; identity/owner/ACL/attributes must
-- match preflight. Text output contains no user data or credentials.
SELECT oid,proowner,prosecdef,proisstrict,provolatile,proconfig,proacl::text AS acl
FROM pg_proc WHERE oid='target_private.wallet_snapshot(uuid)'::regprocedure;
ROLLBACK;
