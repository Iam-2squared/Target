# Operator financial restoration

This mechanism restores financial balances while retaining accounts, answers,
mastery, immutable game results, purchase receipts and owned items. It is private
PostgreSQL operator functionality; there is no browser or public restoration RPC.

`wallet_finance_projection(cutoff)` projects strictly before the supplied timestamp.
It sums quiz awards, calculus credits and voids, birthday receipts, game child rounds,
purchase costs and prior restoration deltas. Batch-parent amounts are never added.
The current projection must reconcile every financial profile field before and after
the operation. Missing or unknown accounting fails the transaction.

Deploy compatible Target and KGS shop validators before executing a restoration.
The optional `refundedSpend` field keeps the original inventory and purchase costs:

```
spent + refundedSpend = original purchase costs + retired map costs
balance + spent = totalIncome
```

The financial restoration itself does not lower source import watermarks. Its frozen
Daily source baseline is excluded through permanent, nonoverlapping void intervals,
including deleted and not-yet-linked source accounts. Subsequent source points above
that baseline remain eligible. Source records and lifetime totals remain intact.

1. Capture authoritative Daily lifetime totals and Target links/void intervals with
   read-only queries. Include deleted and unlinked Daily source IDs.
2. Build and review a fixed manifest containing the cutoff, unique operation ID,
   source capture time, all source baselines, interval complement and its SHA-256.
   An operation ID must never be reused with a newly captured manifest.
3. Prepare the exact SQL locally:

   ```sh
   node scripts/prepare-wallet-restoration.cjs frozen-manifest.json output-directory
   ```

   This command accesses files only and refuses to overwrite an existing operation
   with different inputs. `.preview.sql` is read-only. `.rehearsal.sql` runs the exact
   financial operation and ends with `ROLLBACK`; use it in an isolated local fixture.
4. Apply the reviewed migration and verify compatible clients are ready. Execute
   the frozen `.apply.sql` as the PostgreSQL operator. The wrapper acquires advisory
   lock 991101, locks `system_state`, then blocks profile writers. It checks an
   existing completed operation before any source writes. A stale baseline, unknown
   link, uncovered source interval, history mismatch, unsupported map refund,
   exhausted revision or insufficient audit capacity aborts everything.
5. Verify zero component mismatches, expected restored totals, retained item and
   receipt counts, increasing wallet revisions and the source watermarks. Record
   the completed operation ID and original manifest for any exact retry.

The wrapper captures **B**, the wallet before new source voids; applies source
exclusions; captures **P**, the actual wallet after voids; and restores **A**, the
historical financial projection. Immutable audit rows preserve all three states.
The accounting correction is **A − P**, so new void receipts are counted once.
The refund is **B.spent − A.spent**; voids never change spending. Quiz counters and
mastery are retained, active bonus windows are cleared, and wallet revisions advance.

The tables are `target_private.wallet_restoration_events` and
`target_private.wallet_restorations`. They deny access to public, anon,
authenticated and service_role callers and reject updates/deletes. The audit stores
enough before/after data to review a later separately authorized reversal; this
operation does not automatically undo a completed restoration.
