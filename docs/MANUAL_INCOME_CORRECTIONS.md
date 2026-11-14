# Authorized income corrections

`target_private.adjust_wallet_income(operation_id, manifest)` is an operator-only
mechanism for a one-time, explicitly authorized change to current total income.
Its migration does not contain account IDs or apply any financial operation.
The function is not granted to public, authenticated, or service roles, and no
HTTP route exposes it.

The manifest has exactly `version: 1`, a nonempty `reason` of up to 200 characters,
and `targets`. Each target has exactly `memberId`, `expectedName`, and
`totalIncome`. The caller must identify accounts from the canonical KGS roster
and verify their Target profile names before creating the manifest. Amounts use
the existing 10-轟 grid and 10-trillion ceiling. Operation IDs begin with
`income_adjust_` and have at most 80 characters.

The function preserves recorded spending. A requested income below a member's
current spending rejects the entire operation before any audit or profile
change. It provides no refund, inventory reset, spending write-off, or automatic
negative-balance forgiveness option. Such a request needs a separate, explicit
user decision and an appropriately reviewed mechanism.

Under the existing global financial transaction lock, the helper verifies that
all current wallet components reconcile with their permanent histories. It then
preflights every target and reserves audit capacity. Only `total_points` and the
signed non-study correction component `casino_net` change, by the same delta;
the genuine study component therefore stays unchanged. The existing profile
trigger advances the wallet revision once. Spending, answers, correct counts,
mastery, bonuses, reward locks, purchases, active inventory, source receipts and
imported source high-water marks are preserved.

The existing permanent `wallet_restoration_events` and `wallet_restorations`
tables carry the adjustment. The event's cutoff and prepared timestamps are
both the true correction time, so its empty time interval does not pretend to
refund an older purchase. The before and after-void snapshots are equal because
no source void occurs. `component_deltas.casinoNet` and `totalPoints` record the
authorized delta, all other component deltas and `spent_refund` are zero, and
`incomeCorrection` records the operation kind, reason, target ID/name, requested
income, and preserve-spending policy. These per-member records reconstruct the
normalized request; its sorted canonical JSON is hashed into the event. No game
outcome or source earning receipt is invented or changed.
An `income_adjust_` event records a correction, not a historical inventory-reset
baseline; operators must use a genuine financial restoration as that baseline.

The existing financial projection already includes these permanent component
corrections. Existing wallet snapshots and purchase validation need no changes.
The signed component is retained as an accounting mechanism even when gameplay
has been removed. This operation sets income once; it does not cap later genuine
earnings. The same operation ID and canonical manifest replay before looking at
current wallets, preserving income earned afterward. Edited metadata under the
same ID is rejected.

Because spending refunds are always zero, the mechanism introduces no
unattributed purchase refunds. A real subsequent financial restoration and
inventory restoration continue to reconcile, and their old operation retries
do not overwrite a later income correction or purchase. Existing restoration,
projection, scorer, purchase, and source functions are not replaced.

Verification in `tests/manual-income-correction-db.cjs` uses a disposable
loopback PostgreSQL database, real source/study/purchase APIs, and synthetic
accounts. It covers installation without data changes, below-spending refusal,
multi-member atomicity, exact income/balance arithmetic, immutable audit,
concurrent retries, future earnings, unchanged source watermarks and receipts,
purchase retries and new purchases, rollback, capacity, private permissions,
and subsequent financial/inventory restorations.
