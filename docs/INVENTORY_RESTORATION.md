# Inventory restoration

After compatible Target and KGS clients are deployed, a PostgreSQL operator can
call `target_private.restore_inventory(reset_id, cutoff, base_wallet_reset_id)`.
The referenced completed financial restoration must use the same cutoff.
There is no public or browser endpoint for this operation.

The operator call acquires advisory lock 991101, locks `system_state`, then blocks
profile writers. It creates permanent tombstones for every current 100,000-轟 item
receipt at or after the cutoff. Original receipts, learning, source watermarks,
game results and income remain unchanged. Legacy sticker receipts after the cutoff
and older pre-cutoff tombstones fail closed because those require another policy.

Refunds already recorded by financial restoration audits are matched against their
exact receipt timestamp intervals before any changes. Only remaining charged
receipts receive an additional refund by lowering `spent_points`. The additional
refund also appears in the component projection and `refundedSpend`. Every current
profile receives an increasing wallet revision and a permanent before/after audit.
An exact operation-ID retry returns before selecting candidates, so later valid
draws remain active and cannot be refunded again.

The historical `drawCount` and `legacyDiscountedDraws` remain intact. Active owned
quantities exclude tombstones, and optional `voidedDrawCount` explains the difference:

```
active sticker quantities + active frame quantities = drawCount - voidedDrawCount
spent + refundedSpend = historical gacha cost + retired map cost
```

Replaying a tombstoned receipt returns its original result with
`receiptVoided: true`, the current active quantity (which may be zero), and the
current wallet. It charges nothing and never restores ownership. Fresh draws use
the current active-inventory protocol and remain available normally.

KGS equipped frames must be checked against the surviving ownership separately.
Clear a frame only if the user no longer owns any active copy, and advance KGS
profile versions so an in-flight older equip request cannot restore it.

The audit tables are `inventory_restoration_events`, `inventory_voids`, and
`inventory_restorations` in `target_private`. They enable RLS, deny public/client
roles, and reject updates and deletes. Financial components and active inventory
are verified before commit; any failure rolls back the complete operation.
