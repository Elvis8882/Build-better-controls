# Tournament preset contract

This file is the contract source-of-truth for tournament preset behavior across SQL routines and frontend helpers.

## Accepted persisted values (`tournaments.preset_id`)

- `playoffs_only`
- `full_with_losers`
- `full_no_losers`
- `2v2_tournament`
- `2v2_playoffs`
- `round_robin_tiers`
- `goal_difference_duel`

## Legacy value policy

- `full_tournament` is a **legacy** value.
- Contract decision: **reject legacy/unknown preset values at runtime** (no silent fallback mapping).
- Reason: all persisted legacy rows are migrated in SQL; any reappearance indicates upstream drift that must fail fast.

## Implementations bound to this contract

- Frontend/app helper: `src/lib/tournament-preset-contract.ts`
- SQL normalizer routine: `supabase/routines/normalize_tournament_preset.sql`

## Full tournament placement flow

For `full_with_losers`, the winners final determines first and second place. The placement bracket determines third and fourth; it does not reset the championship final. The supported bracket range is 3–16 entrants.

Placement generation uses the actual seeded winners layout. It alternates rounds that admit winners-bracket losers with rounds that consolidate placement winners. Every played placement match has exactly two sources. Structurally empty matches are collapsed before any results are entered; a missing participant from a pending source is never treated as a BYE. Three entrants need no bronze game: the sole semifinal loser receives third place. Eight entrants retain dedicated 5th/6th and 7th/8th games.

Final rankings use locked results. After all playable matches finish, remaining places are ordered by placement elimination round, then playoff goal difference, goals scored, goals conceded, and participant ID. A placement loss always supersedes an earlier winners-bracket loss, regardless of the numeric round labels. Bracket standings and team statistics share this calculation. Pending placement matches remain visible and prevent tournament completion.

Apply `supabase/migrations/20261022120000_fix_uneven_placement_graph.sql` before deploying the matching frontend. Existing tournaments with locked playoff results keep their original graph and results; this migration deliberately does not rebuild them. Unstarted brackets can be regenerated through the existing authorized bracket RPC. A broken tournament that already has locked results needs a separate, reviewed data-repair plan; rebuilding it would violate the locked-result contract.

Run `supabase/scripts/20261022120000_regression_uneven_placement_graph.sql` against PostgreSQL after applying migrations. It exercises the installed graph and advancement bodies for 3–16 entrants, two lock orders, alternating winners, home/away balancing, and a noncanonical five-player group layout, using temporary tables and a rollback. Identity synchronization and preset predicates are stubbed; this fixture does not test RLS or the full group-lock/RPC lifecycle.
