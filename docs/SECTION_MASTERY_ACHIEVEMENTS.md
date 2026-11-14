# Section mastery achievements

The authenticated mastery response keeps the existing personal percentages and
review numbers. Each Section additionally includes `achievers`, an array of
`{memberId, name, achievedAt}`. This lists every learner whose 100% completion
has been observed by the server for that textbook and Section. The list is
ordered by first recorded completion, then member ID. Empty lists are `[]`.

`section_mastery_achievements` is private, RLS enabled, and keyed by member,
textbook and Section. No browser role can read or write it directly. Usernames
come from the current Target profile, which is refreshed from the verified KGS
identity; changing a name does not reset or duplicate an achievement. The
existing authenticated mastery route is the only response that exposes this
new data. Other learners' word streaks and review numbers stay private.
The mastery transport alone allows up to 3 MiB so all 500 supported members
can appear in all 19 Sections, including worst-case JSON escaping of names.
Other RPC response limits remain unchanged; lists are not truncated.

Two consecutive accepted correct answers still master a word. A wrong answer
still removes its current mastery, and two later consecutive correct answers
restore it. Once all 100 words in a Section have streak two, its first
achievement persists through misses, relearning, retries and quiz cleanup.
Account-wide reward suppression remains separate: a correct answer awarding
zero during recovery still advances mastery and can complete a Section.

The new `target_section_mastery_achievement` AFTER INSERT answer trigger runs
after `target_record_word_mastery` in PostgreSQL's alphabetical trigger order.
It checks canonical quiz material and the updated mastery rows in the same
transaction. The existing global transaction lock serializes simultaneous
completions, and the primary key prevents duplicates. This also observes a
scorer invocation compiled before the schema change. A failed or rolled-back
answer cannot leave an achievement behind. Existing scorer and mastery-update
function definitions are not replaced.

Each permanent achievement consumes 256 logical bytes. At trigger time any
new word-row charge is already included, while the answer's own charge is
still pending; the quota check reserves both that pending answer charge and
the new achievement. Failure raises the scorer's existing capacity exception
and rolls back the answer, word update, counters and achievement together.

On activation, currently 100% Sections are seeded from authoritative mastery
rows. Their timestamp is when the server first observed completion at this
cutover, not an invented past achievement date. Past completion of a Section
that is currently below 100% cannot be established safely from retained answer
history: expired quiz details may have been deleted, receipt timestamps are
transaction-start times, zero-award correct answers share point snapshots, and
non-study incomes and financial restorations can change those snapshots. The
migration does not infer or fabricate those historical achievements. All
subsequent server-observed completions are recorded permanently.

Verification uses synthetic profiles and genuine scorer transactions only in
a disposable loopback PostgreSQL database. It covers all textbooks, current
completion seeding, permanent names after misses, verified name changes,
concurrent completion and receipt retries, reward-lock zero awards, transaction
rollback, exact storage boundaries and the private privilege surface.
