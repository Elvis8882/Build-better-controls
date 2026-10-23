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

Placement generation uses the actual seeded winners layout. It alternates rounds that admit winners-bracket losers with rounds that consolidate placement winners. Every played placement match has exactly two sources. One-source BYE matches remain visible in their original source round and auto-advance without fabricated scores. Only wholly empty branches are omitted; a missing participant from a pending source is never treated as a BYE. For ten entrants, the two opening losers each enter a separate round-of-16 placement BYE. The next stage contains those two advancers plus four quarter-final losers: six entrants in four matches, including two BYEs. For 9, 10, and 11 entrants respectively, this stage has 5, 6, or 7 entrants; award the highest-ranked 3, 2, or 1 entrants the BYEs, leaving four survivors. Rank the complete pool by overall group-stage points, goal difference, shot difference, rank within the group, then participant ID. Do not use group-by-group playoff seed order or result-lock order. Match assignments and bye advancement wait until every source loser is known. Without group-stage standings, use the persisted playoff seeds as the fallback order. A separate qualifying round reduces the four survivors to two before the winners-semifinal losers join. Three entrants need no bronze game: the sole semifinal loser receives third place. Eight entrants retain dedicated 5th/6th and 7th/8th games.

For group-based `full_with_losers` draws, rank entrants using the same overall standings order above. Preserve the strongest seeds' BYEs, keep the stronger half of entrants on separate opening paths, and place seeds 1 and 2 in opposite halves. In a sixteen-slot tree the top four occupy separate quarters. Assign weaker opponents to minimize same-group opening games, then seed deviation; arrange the remaining paths to minimize possible same-group meetings in the following round, then seed deviation. This is deterministic and supports two or three groups, including unequal group sizes. Cross-group games are preferred within those seed constraints; they cannot be guaranteed for every possible distribution or later result. For the 9–11-player placement quarter-final draw, preserve the ranked BYEs and stronger/weaker opponent bands, then prefer different groups, fewer repeat playoff opponents, and conventional seed pairing in that order.

Home priority is independent of BYE eligibility. Winners-bracket games give home to the higher overall group-stage finisher. Placement games first compare each player's actual locked, non-tied defeat in a two-player winners-bracket match: the player who lost in the later round is home. Equal loss rounds, or a missing loss round for either player, fall back to overall group-stage placement. For example, the overall winner who loses in the opening round is away against a lower-ranked player who loses in the quarter-finals. Without usable group standings, compare persisted playoff seeds; if neither ranking is usable, participant ID gives a stable final fallback. These rules grant home advantage rather than targeting a 50/50 home/away count. Side-specific drop metadata, feeder sides and participant identities follow any swap. Locked matches and closed tournaments retain their orientation.

Final rankings use locked results. After all playable matches finish, remaining places are ordered by placement elimination round, then playoff goal difference, goals scored, goals conceded, and participant ID. A placement loss always supersedes an earlier winners-bracket loss, regardless of the numeric round labels. Bracket standings and team statistics share this calculation. Pending placement matches remain visible and prevent tournament completion.

Apply `supabase/migrations/20261022120000_fix_uneven_placement_graph.sql` then `supabase/migrations/20261022140000_preserve_placement_round_byes.sql`, `supabase/migrations/20261022160000_seed_placement_byes_by_overall_group_rank.sql`, and finally `supabase/migrations/20261023120000_fair_group_draw_and_stage_based_home.sql` before deploying the matching frontend. Existing tournaments with locked playoff results keep their original graph and results; this migration deliberately does not rebuild them. Unstarted brackets can be regenerated through the existing authorized bracket RPC. A broken tournament that already has locked results needs a separate, reviewed data-repair plan; rebuilding it would violate the locked-result contract.

Run `supabase/scripts/20261022120000_regression_uneven_placement_graph.sql` against PostgreSQL after applying migrations. It exercises the installed graph and advancement bodies for 3–16 entrants, two lock orders, alternating winners, home/away balancing, and a noncanonical five-player group layout, using temporary tables and a rollback. It also checks the 9/10/11-player bye recipients against overall group standings that deliberately disagree with playoff seed order, defers the draw until the full pool is known, and checks repeated seeding. Identity synchronization and preset predicates are stubbed; this fixture does not test RLS or the full group-lock/RPC lifecycle.

Run `supabase/scripts/20261023120000_regression_group_draw_and_home_priority.sql` for the complete installed generator: 57 full tournaments across two groups (6–16 entrants), three groups (9–16 entrants), three outcome/draw scenarios, and explicit fallback/immutability cases. It checks ranked BYEs, cross-group openers where feasible, top-seed separation, progression, total games, home priority, metadata routing, and real identity synchronization with users and guests. Preset predicates and data relations are temporary stand-ins; production authorization and RLS remain outside this fixture. Run `supabase/scripts/20261023100000_audit_uneven_bracket_counts_and_balance.sql` for the 390-outcome 9/10/11-player audit and actual group-scheduler totals.
