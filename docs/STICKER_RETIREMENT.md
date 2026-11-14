# Sticker retirement and refunds

The 2026-11-10 retirement disables all existing sticker purchases and ownership.
Avatar frames, study income, external sources, matches, and past purchase
receipts remain intact. Sent chat messages are handled by KGS; they are not
financial purchase records and this migration does not delete them.

The reviewed migration applies its schema changes and the authorized operation
`target_private.retire_stickers('sticker_retire_20261110_v1')` in one transaction.
There is no public retirement API. The private operator function accepts only
that fixed operation ID and returns the original receipt on an exact retry.

For each currently active sticker receipt, it subtracts the canonical amount
already refunded financially from the immutable original cost. Only this
remaining paid amount is refunded, by lowering `profiles.spent_points`.
`total_points` and every income component remain unchanged. This includes
duplicate modern purchases, original 10,000-轟 purchases, historical
100,000-轟 legacy receipts, complete financial refunds, and partial or complete
receipt write-offs. Already voided receipts are excluded.

The operation reuses the permanent inventory events, tombstones, and per-member
audits. Only this fixed current-time retirement may have a null financial-reset
base. A strict immutable-receipt trigger covers both historical purchase tables
and verifies the exact residual and its proof event. This replaces the former
modern-only tombstone foreign key, without making either receipt table mutable.
The existing financial projection body is unchanged.

The batch acquires advisory lock 991101, locks `system_state`, and blocks profile
writers before calculating any amounts. Capacity, receipt coverage, profile
limits, revision limits, exact before/after wallet differences, old source and
ownership history, and projection reconciliation are checked inside the same
transaction. Any failure rolls back both the refund and the schema change.
Only affected owners receive a wallet revision increment.

The durable event activates catalog version 4, `catalogSize: 0`, and
`stickersRetired: true`. Historical `drawCount` and `legacyDiscountedDraws` remain
unchanged; `voidedDrawCount` explains removed ownership and `refundedSpend`
explains refunded spending. Frames keep their active quantities, price and odds.
New frame purchases acknowledge version 4. New sticker requests return
`410 STICKERS_RETIRED` before allocating a profile, rate row, receipt or charge.
Old receipt retries preserve their original result and cost but return
`receiptVoided: true`, quantity zero and the latest wallet. A table trigger also
rejects a stale compiled purchase writer; cached applications cannot repurchase
a retired sticker or charge with the previous frame protocol.

`supabase/tests/target_sticker_retirement_verify.sql` is a read-only postflight.
It pins the reviewed private and public boundaries and verifies permanent
audits, exact refunds, historical cost proofs, frame preservation, empty active
sticker ownership, private permissions and financial reconciliation.
`tests/sticker-retirement-db.cjs` exercises the exact migration with synthetic
identities in a disposable loopback database.
