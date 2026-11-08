-- Stop both generations of map RPCs, including callers on older deployments.
-- Keep wallet functions, balances and all immutable purchase receipts intact.
SELECT pg_advisory_xact_lock(991101);

CREATE OR REPLACE FUNCTION public.target_map_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='25s' AS $$
BEGIN
  IF p_secret IS NULL OR length(p_secret)<32 OR length(p_secret)>256 OR NOT EXISTS(
    SELECT 1 FROM target_private.server_credentials WHERE singleton AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
    RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。');
  END IF;
  RETURN target_private.error_result(410,'MAP_REMOVED','マップは削除されました。');
END $$;

CREATE OR REPLACE FUNCTION public.target_territory_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='25s' AS $$
BEGIN
  IF p_secret IS NULL OR length(p_secret)<32 OR length(p_secret)>256 OR NOT EXISTS(
    SELECT 1 FROM target_private.server_credentials WHERE singleton AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')) THEN
    RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。');
  END IF;
  RETURN target_private.error_result(410,'MAP_REMOVED','マップは削除されました。');
END $$;
