# Gambling removal

`target_gambling_removed` closes the durable gambling entry points under the
existing shared transaction lock (`991101`). With a valid server credential,
`state`, `play` and `batch` return `410 / GAMES_REMOVED`, including requests
using an already committed round UUID. Invalid credentials retain their prior
forbidden response. No removal request creates or updates a profile.

An old RPC invocation may have compiled before the migration and then waited
for the transaction lock. The existing round and batch insert triggers now
unconditionally reject writes. Game quota inserts and updates, including
renaming an existing game bucket, also reject before entropy is sampled. A
new child-link insert trigger closes the remaining batch relation. Old protocol
markers cannot re-enable any of these writes. Other rate limits still work.

The read-only `snapshot` action remains available behind the server credential
to support already deployed quiz-answer handlers. It returns the existing
wallet helper and cannot start or settle a game. Ordinary quiz grading,
mastery, item ownership, source-income imports and financial projections use
their existing definitions.

Round, batch and child-link histories are retained unchanged. Removal does not
refund or erase earlier wins, losses or spending. Any separately requested
account-total adjustment belongs to its own audited financial operation.

`tests/gambling-removal-db.cjs` uses a disposable loopback PostgreSQL database.
It verifies a genuinely queued old invocation, closure before randomness and
quota changes, unchanged historical receipts and unrelated function hashes,
protocol-marker attempts, direct insert fences, credential and role boundaries,
read-only wallet compatibility and genuine quiz-answer acceptance.
