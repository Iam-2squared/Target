# Unequal soccer stakes

Each player can offer a different amount, in 100轟 increments. A new client
sends `expectedHostOffer` and `expectedGuestOffer` with its explicit `ready:true`
confirmation. Both must match the current locked offers. Missing unequal
confirmation returns `STAKE_CONFIRMATION_REQUIRED`; a changed pair returns
`STAKE_CHANGED`. Changing either offer clears both approvals. Replaying a saved
ready request only acknowledges the current match; it cannot renew an approval.
Equal legacy clients can still confirm without the two acknowledgement fields.

Each wallet reserves its own offered amount. The winner receives the combined
pot, so its net profit is the opponent's deposit. A draw, mutual cancellation or
idle expiry refunds each original deposit. Funding checks each available balance
and each winner's possible net profit against the existing shared wallet bounds.
Later earnings must retain headroom for the full pending pot.

`matches.stake` remains the funded host amount for compatibility. New matches
also save `guest_stake`; historical rows keep it NULL and use their original
common `stake`. Neither prior matches nor immutable receipts are rewritten.
The DTO exposes `host.stake`, `guest.stake` and `pot`; unfunded seat stakes are
NULL, a waiting pot sums current offers, and an unfunded cancelled pot is zero.

New private triggers validate every reserve, payout and refund against its
participant and actual funded amounts. A second guard freezes funded amounts
and requires both exact reserve receipts before entering play. Unequal funding
also requires the transaction's validated pair acknowledgement. Together these
checks reject stale compiled common-stake writers without a partial debit or
incorrect guest refund. They have no application-role privileges or HTTP route.

The migration and strict read-only postflight preserve the financial projection,
study and source receipts, birthday gifts, retired-sticker refunds, owned avatar
frames, random shared formations, turn clock and deterministic soccer rules.
The disposable database regression exercises both winners, 100/200 and billion
amounts, all refund paths, stale/concurrent approvals, canonical writer fences,
legacy funded matches, balance/headroom failures and exact source reconciliation.
