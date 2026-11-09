# Two-player soccer database contract

The separate `/workspace/2player` application verifies a KGS common login on its server, then calls `public.two_player_rpc(secret, action, input)`. The dedicated secret belongs only on that server. Its SHA-256 hash is provisioned separately in `target_private.two_player_credentials`; this migration contains neither a secret nor a financial correction manifest. Existing Target gambling RPCs remain disabled.

The migration was created with `npx --yes supabase@2.106.0 migration new target_two_player_soccer`. It only adds the new soccer mechanism and minimally extends the reviewed wallet projection. The schema and data changes must be applied through the normal reviewed deployment process.

All actor fields come from the verified KGS identity. Every call supplies `memberId` (UUID) and `name` (1–20 characters). Mutations also supply a fresh UUID `requestId`. Reusing an accepted request ID with different content returns `409 REQUEST_CONFLICT`; an exact retry returns the current wallet and match without repeating the action.

| Action | Additional input | Behavior |
| --- | --- | --- |
| `wallet` | None | Current shared wallet and reserved stake |
| `list` | None | This member's latest 20 rooms, active rooms first; no global room directory |
| `create` | `stake` | Create a private six-character room code |
| `join` | `code` | Join an available room using its code |
| `offer` | `matchId` or `code`, `stake` | Change the actor's offer and clear both confirmations |
| `ready` | `matchId` or `code`, `ready` boolean | Confirm the matching offers; the second confirmation funds both stakes atomically |
| `state` | `matchId` or `code` | Resume an owned match; may claim a pending calculation for the trusted server |
| `input` | `matchId` or `code`, `round`, `version: 1`, integer `angle: 0..359`, integer `power: 0..100` | Lock the active player's shot once |
| `resolve` | `matchId` or `code`, `round`, `version: 1`, `claimToken`, `goal`, `state`, `frames` | Trusted server commits the deterministic physics result |
| `cancel` | `matchId` or `code` | Cancel before funding, or request mutual cancellation after funding |
| `expire` | None | Expire this member's idle match without funding anything |

Success returns `{ok:true,wallet,match? ,rooms?}`. Errors use the existing `{error:{status,code,message}}` convention. Wallet fields are `balance`, `totalIncome`, `spent`, `walletRevision`, `gameNet`, and `escrow`. The existing identity `balance + spent = totalIncome` remains exact. `balance` excludes the reserved stake; `escrow` is that member's reserved stake. Match `escrow` is the full two-player pot. Match `winner` is `host`, `guest`, `draw`, or null. A room's `stake` remains null until both players confirm.

Gameplay uses alternating turns. A server-generated random bit selects the first player when both stakes are reserved. The database accepts input only from `match.turn`. One accepted shot produces a private `_processing` claim containing `claimToken`, `matchId`, `round`, `version`, `turn`, `state`, and `inputs:{host,guest}`. The inactive input always has zero power. The claim lasts ten seconds; a later `state` call can reclaim an abandoned calculation. A stale token cannot resolve. The application server must remove `_processing` from browser responses and never expose a browser route for `resolve`.

The physics result is independent of connection latency. Physics version 1 uses a 640×960 field and canonical kickoff state `{"players":[{"x":320,"y":720},{"x":320,"y":240}],"ball":{"x":320,"y":480}}`. The trusted server simulates the input and commits `goal: "host" | "guest" | null`, final `state`, and replay `frames`. On a goal, both `match.state` and the physics outcome's `lastRound.state` reset to kickoff; `lastRound.frames` retains the goal entry for animation. Every resolved shot flips the turn. Three goals wins; reaching 40 shots without a three-goal winner draws and refunds both stakes. Resolved inputs and results are permanent, and identical result retries cannot create another payout.

Both offers must be 100–100,000 轟 in steps of 100. Creating, joining, offering, listing, polling, and the first confirmation never reserve money. The second explicit confirmation validates both balances before either debit. Reservation appends a `-stake` event for each player and subtracts exactly that amount from `profiles.total_points` and `casino_net`. Settlement appends either `2*stake` to the winner and zero to the loser, or `stake` to each player on a draw/cancellation. Every event is append-only and unique by match, member, and reserve/settlement phase. Neither `spent_points` nor gacha ownership changes. The existing wallet revision trigger applies to each nonzero financial change.

Every financial action uses the existing global advisory lock `991101`. For every match, `sum(two_player_wallet_events.delta) + match.escrow = 0`. The finance projection's games component adds these deltas exactly once alongside the old immutable casino receipts. Existing source voids, external source recoveries, income corrections, full/partial receipt write-offs, inventory tombstones, and restoration audits remain intact. Shared wallets retain enough upper-bound headroom for any outstanding soccer payout.

After funding, either player may request cancellation, and both requests refund both players. An unresolved match expires ten minutes after its last accepted input, resolution, offer, join, or confirmation. Polling and repeated inputs do not prolong the deadline. Expiry cancels and refunds; it never awards a latency-based win. Confirmed winners cannot be undone by expiry. `target_private.two_player_expire(NULL,100)` processes up to 100 expired matches, and a conditional `pg_cron` installation schedules it once per minute where the extension is available. Plain local PostgreSQL skips the optional extension. The private cron function needs no new storage to refund.

All new tables have RLS and explicit revokes from `PUBLIC`, `anon`, `authenticated`, and `service_role`. Only the credential-gated public RPC is executable by API roles. Credential checks run before input parsing, rate allocation, locks, or expiry. New identities respect Target's existing 500-profile ceiling; existing members can still resume and refund at that ceiling. Each member is limited to one active match, 240 calls per minute, 20 created rooms per UTC day, and 256 ordinary accepted mutation receipts per match. JSON inputs, physics state, replay samples, and result bytes are bounded.

The existing 100 MiB logical storage ceiling covers this feature. A new match reserves 16,384 bytes for its bounded match/participant/finance records and two cancellation receipts. Ordinary request receipts reserve 512 bytes; rate slots reserve 256 bytes. Each accepted shot reserves 131,072 bytes so its result can finish even if another operation consumes the remaining capacity. Resolution replaces that reservation with `2048 + pg_column_size(frames) + pg_column_size(state)`, including the result receipt. Cancelling a pending shot releases all but 1,024 bytes for its immutable input. Rate slots expire after a day; permanent finance/input/request receipts remain. Refunding and first resolution need no fresh quota allocation.

Historical wallet restoration is refused for a member with funded active soccer escrow. It also refuses a historical cutoff between that member's reserve and settlement events, including a match that has already finished, because that would restore a debit without its corresponding escrow. Cancel/refund active matches and choose a cutoff before reservation or after settlement. Existing explicit current-time income corrections with `cutoff_at = prepared_at` continue to work; no automatic money adjustment is introduced.

For verification, run the local-only `/workspace/2player/tests/e2e-soccer.cjs` harness and the read-only `supabase/tests/two_player_soccer_verify.sql` postflight. The harness requires `NODE_ENV=test`, a loopback-only disposable PostgreSQL database, and synthetic identities. It never accepts a hosted database URL.
