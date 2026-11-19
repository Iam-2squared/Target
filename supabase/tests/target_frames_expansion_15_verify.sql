-- Read-only postflight: Target only; does not expose private member data.
DO $verify$
DECLARE t integer;
BEGIN
 IF (SELECT count(*) FROM target_private.frame_catalog)<>48
 OR (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='common')<>15
 OR (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='rare')<>15
 OR (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='epic')<>10
 OR (SELECT count(*) FROM target_private.frame_catalog WHERE rarity='legendary')<>8
 THEN RAISE EXCEPTION 'Unexpected frame counts'; END IF;
 FOR t IN SELECT 1 FROM target_private.frame_catalog WHERE id~'^(r1[1-5]|e0[6-9]|e10|l0[4-8])$' LOOP
  EXIT;
 END LOOP;
 IF (SELECT count(*) FROM target_private.frame_catalog WHERE id~'^(r1[1-5]|e0[6-9]|e10|l0[4-8])$')<>15
 THEN RAISE EXCEPTION 'Some new frames missing'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.item_draws d LEFT JOIN target_private.frame_catalog f ON d.frame_id=f.id WHERE d.frame_id IS NOT NULL AND f.id IS NULL)
 THEN RAISE EXCEPTION 'Historical frame receipts lost'; END IF;
 IF (SELECT (target_private.wallet_snapshot(member_id)->>'frameCatalogSize')::integer
     FROM target_private.profiles LIMIT 1)<>48
 THEN RAISE EXCEPTION 'Wallet does not advertise expanded frames'; END IF;
 IF has_table_privilege('anon','target_private.frame_catalog','SELECT')
 OR has_table_privilege('authenticated','target_private.frame_catalog','SELECT')
 THEN RAISE EXCEPTION 'Frame inventory exposed'; END IF;
 IF (SELECT logical_bytes FROM target_private.system_state WHERE singleton)>104857600
 THEN RAISE EXCEPTION 'Over logical storage cap'; END IF;
END $verify$;
