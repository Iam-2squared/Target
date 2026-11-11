# Target: non-destructive replay quota correction (2026-11-11)

## Symptom and root cause
A recorded Target quiz returns HTTP 507 `CAPACITY_LIMIT`, even though the Target project's PostgreSQL storage is not physically full. Learning and 2-player soccer share a deliberate **100 MiB application-accounting ceiling** through `target_private.system_state.logical_bytes`.

Soccer V2 reserves up to 393,216 bytes before accepting a shot, then records `charged_bytes = 2048 + pg_column_size(input.frames) + pg_column_size(input.state)`. These input values are **uncompressed JSONB**. PostgreSQL TOAST-compresses the saved JSONB, so quota billing vastly exceeds persisted-size accounting. On 2026-11-11 read-only production audit: 1,415 completed shot rows were billed 61,999,732 bytes, whereas `2048 + pg_column_size(stored.frames) + pg_column_size(stored.state)` summed to 6,974,726 bytes; difference **55,025,006 bytes**. Original quota was 104,857,000 / 104,857,600 bytes.

## Change
Add `two_player_replay_quota_credits` in the private schema, plus an AFTER resolution trigger. The trigger SELECTs the persisted row rather than `NEW.frames`: PostgreSQL AFTER trigger `NEW` still carries uncompressed JSONB, confirmed in a rolled-back DB probe. The credit is the positive difference between the unchanged original per-shot charge and the persisted-size charge. A one-time, idempotent backfill credits finished shots. All operations use the existing `991101` advisory lock and update quota and credit record atomically.

**Important boundary:** Existing shot inputs, movement frames, physics state, result hashes, wallet ledger, scores, quiz questions/answers, and immutable-result trigger are **never deleted or edited**. This corrects **application accounting**; it does not falsely claim to reclaim 55 MB of actual PostgreSQL disk. The input/request size caps, pre-shot worst-case reservation and 100 MiB final quota remain.

No new environment variables, paid services, HTTP routes, or changes to KGS, the 2player app, or Target frontend are required. The existing `two_player_rpc` makes this migration backward compatible with the deployed Vercel application.

## Deployment and verification
1. Confirm the intended Target project (`wnamppudojisoshepavu`) and source branch (`codex/target-study-v1`); use a different private test database for integration tests.
2. Use a rollback-only preflight of the migration against the live schema to check DDL, unique credit, original snapshot preservation, trigger installation and quota reconciliation.
3. Apply migration `target_replay_quota_credits_20261111` once to Target only, with the same advisory lock. Do not manually overwrite the counter, truncate tables or restore from an older snapshot.
4. Run `supabase/tests/target_replay_quota_verify.sql` read-only. Confirm expected quota, private RLS/ACLs, enabled immutable-result trigger, permanent credits, and unchanged row/receipt counts.
5. Confirm the anonymous Target route still refuses protected actions and the production Vercel alias remains unchanged. A logged-in user should verify a 10/50/100-question recorded quiz and a normal 2-player shot separately when possible.

Rollback: if DDL fails, the transaction should roll back without changing user data. If a later version needs correction, publish an additive migration; do not delete or reset immutable match rows or credit history.

## Deliberate limits
Stored-size accounting is specific to **already resolved** replay data. An unresolved shot retains the full worst-case reservation for safety and a cancelled move retains the original reduced reservation. New resolved shots receive at most one credit via a separate primary key. This is not a cleanup of permanently recorded settlement evidence and does not grant unlimited physical storage.
