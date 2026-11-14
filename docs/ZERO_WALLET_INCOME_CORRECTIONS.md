# Explicit zero-wallet income corrections

`target_private.zero_wallet_income(operation_id, manifest)` supports an explicit
operator request to set both total income and recorded spending to the requested
amount, leaving a zero balance while preserving owned items. Its migration does
not contain account IDs or execute a correction. It is private and has no HTTP
route or application-role permission.

The manifest format is the same as the ordinary income correction: exactly
`version: 1`, a nonempty `reason` of up to 200 characters, and `targets`, each with
exactly `memberId`, `expectedName`, and `totalIncome`. IDs begin with `zero_income_`.
The requested income must be on the existing spending grid of 100轟, no greater
than current recorded spending, and no lower than actual map/territory spending.
The signed non-study correction component must remain within its existing bounds.

Under the global financial lock, the operation reads the actual current wallet.
It computes the spending write-off as `old spent - requested income`; it never
uses a previously quoted balance or spending amount. The income delta is recorded
in the existing signed `casino_net` correction component. Study/source receipts,
learning state, source import watermarks, bonuses and all existing purchases are
preserved. The existing wallet revision advances once.

Every轟 of written-off spending is attributed to canonical, active, unrefunded
100,000轟 `item_draws` receipts in the private append-only
`manual_receipt_writeoffs` table. The newest receipts are used first. A receipt
may be written off fully or partially on the 100轟 grid, and cumulative allocation
can never exceed its immutable cost. Legacy receipts and map expenses are not
eligible. Insufficient eligible receipts, more than 5,000 allocation rows, or
insufficient audit capacity reject the operation atomically. The operation records
its normalized request, exact before/after financial snapshots, spending delta,
and allocation totals in the existing permanent correction ledger.

The current wallet remains compatible with existing purchase proofs:
`spent + refundedSpend = immutable purchase cost + mapSpent`. Active item counts
and item quantities do not change. A repeated operation ID with the same canonical
manifest acknowledges the original correction without erasing later earnings or
purchases; changed metadata under the same ID is rejected.

Future item restoration refunds only the remaining paid cost. For example, a
100,000轟 receipt written off by 70,100轟 can later refund only 29,900轟. A full
historical financial refund supersedes a partial allocation for coverage purposes
rather than counting the same cost twice. Refund event/member amount grids now
permit 100轟 residuals. An exact canonical-proof trigger validates the amount and
event for every new inventory tombstone, also rejecting an old compiled inventory
writer that attempts to refund the full cost again. Existing tombstones and
restoration receipts are not rewritten.

Deferred member-scoped coverage checks protect commits of financial restorations
and manual allocations for members with write-offs. They include already compiled
financial writers. A historical cutoff that crosses a write-off while retaining
its allocated purchase can require reversing and reallocating that old write-off;
this policy is intentionally unsupported and is rejected before commit, leaving
wallets and receipts unchanged. As with pre-existing unsupported old-inventory or
negative-refund cutoffs, such an operator request needs a separately reviewed
policy. Cutoffs before the allocated purchases and cutoffs after the write-off
remain supported. Choosing the newest eligible receipts keeps ordinary rewinds
to an earlier daily cutoff in the supported case.

The financial projection, ordinary wallet snapshot, quiz scorer, purchase RPC,
source import functions and existing no-spend income helper remain unchanged.
