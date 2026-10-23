# Placement bracket audit — 23 October 2026

## Scope and evidence

Audited the current local implementation, including the fix that hides automatic BYEs from score-entry forms. This tests repository routines in an isolated PGlite PostgreSQL runtime, not the production database or its RLS/RPC lifecycle.

Validation completed:

- Existing SQL regression: 3–16 entrants, two result-lock orders.
- New audit: 130 tournaments each for 9, 10 and 11 entrants (390 total). Each size has an all-home-wins path, an all-away-wins path, and 128 pseudorandom outcome paths. Synthetic overall group rankings vary independently to stress bye selection. These are correctness samples, not probability estimates or an exhaustive outcome enumeration.
- Complete cross-group generator: 57 tournaments with two groups (6–16 entrants) or three groups (9–16 entrants), ranked BYEs, separated top seeds, home priority, real user/guest identity synchronization, plus explicit fallback and immutability cases.
- Actual group-stage generator: both supported group counts (2 and 3) for each entrant count.
- Server-rendered match forms and bracket diagrams: 9, 10 and 11 entrants.

The SQL fixtures read installed routine definitions, use temporary tables/functions, and roll back. The outcome audit varies overall group placement independently of winners seeding. The full-generator fixture also tests group membership and actual identity synchronization.

## BYEs and played-match counts

| Entrants | Opening placement BYEs | Quarter-final entrants | Ranked quarter-final BYEs | Quarter-final games | Winners games | Placement games | Total playoff games |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 9 | 1 | 5 | Best 3 | 1 | 8 | 6 | 14 |
| 10 | 2 | 6 | Best 2 | 2 | 9 | 7 | 16 |
| 11 | 3 | 7 | Best 1 | 3 | 10 | 8 | 18 |

All trials completed with the expected counts, no stranded real matches, no self-matches, and no scored BYEs. Ranked quarter-final BYEs went to the correct highest-ranked eligible entrants. There are four structural placement BYEs in each size: opening BYEs plus quarter-final BYEs. All four remain in the diagram and are excluded from score-entry forms.

Each quarter-final pool produces four survivors. The existing qualifying round reduces those four to two; the two winners-semifinal losers then join to form the placement semifinals. These later stages add two qualifier games, two semifinal games and one third-place final.

For these three sizes, winners games = N − 1, placement games = N − 3, and playoff games = 2N − 4. With a fixed group configuration, outcomes do not change the completed tournament's game count. BYE records are excluded.

Observed individual playoff counts were **2–6 games** for every size. Six is also the longest possible played path: winners opening game, winners quarter-final, placement quarter-final, qualifier, semifinal and final. Championship finalists play 3 or 4 playoff games. Add the player's group size minus one for their group-stage games.

## Full tournament totals

The current creation rules allow 2 or 3 groups for 9–11 participants: groups contain at least 3 and at most 7 players. The group stage is a single round robin.

| Entrants | Two-group sizes | Group games | Full total with 2 groups | Three-group sizes | Group games | Full total with 3 groups | Full min–max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 9 | 5 + 4 | 16 | 30 | 3 + 3 + 3 | 9 | 23 | 23–30 |
| 10 | 5 + 5 | 20 | 36 | 4 + 3 + 3 | 12 | 28 | 28–36 |
| 11 | 6 + 5 | 25 | 43 | 4 + 4 + 3 | 15 | 33 | 33–43 |

These are completed single-game tournament totals, excluding withdrawals, forfeits that remove fixtures, additional classification games, and any future multi-leg format. General formula: sum of g(g − 1)/2 over all group sizes g, plus 2N − 4 playoff games.

## Home/away findings

**Group-stage scheduling passed.** All six actual generator configurations had home/away differences of at most one per player. Odd-sized groups (3 or 5) produced equal home and away counts. Even-sized groups (4 or 6) differed by one, which is unavoidable with an odd number of games per player.

**Playoff home priority now follows the requested hierarchy.** Winners matches use overall group-stage placement. Placement matches prefer the player whose actual winners-bracket loss came later; equal or unavailable loss stages use overall group placement. Missing group standings fall back to persisted playoff seeds, then a deterministic participant ID comparison. Locked results and closed tournaments are preserved. BYEs, ties and unlocked results do not establish a loss stage.

This is an advantage policy, not proportional scheduling. The updated trials still include a player with six away games and no home games. Group-stage scheduling retains its at-most-one-game difference.

## Hierarchy and fairness findings

1. **The requested placement-bye hierarchy passes.** Selection uses the complete eligible pool and overall group placement; branch position and the order results are locked do not award the BYEs.
2. **Unequal groups make raw overall points less comparable.** For example, a player with four regulation wins in a five-player group earns 12 points, while a player with three regulation wins in a four-player group earns 9. Both are undefeated. The current overall ranking deliberately uses raw points, goal difference and shot difference, not per-game rates. Normalizing across unequal groups would be a rules change, not a routing fix.
3. **Cross-group hierarchy is now explicit.** Stronger seeds and ranked BYEs remain protected; opening games prefer different groups, and the next-round arrangement also minimizes possible same-group pairings. Placement quarter-final games prefer different groups, then avoid repeat playoff opponents within the allowed seed bands. Rematches remain possible later or when no alternative fits the hierarchy. Repeat pairs occurred in 72/130, 64/130 and 62/130 updated synthetic outcome trials for 9, 10 and 11 entrants respectively; these samples are not real-world probability estimates.
4. **Later winners-bracket elimination earns later placement entry.** Winners-semifinal losers bypass earlier placement rounds. An earlier winners-bracket loser can still beat them and finish third, as expected in this consolation format.
5. **Lower placements still use statistics when no classification game exists.** Players eliminated in the same placement round are ordered by playoff goal difference, goals scored, goals conceded and participant ID. With 2–6 playoff games per player, cumulative statistics reflect unequal opportunities. Exact head-to-head places would require additional classification games and higher tournament totals.

The accompanying migration implements cross-group draws and stage-based home priority. The overall standings comparison and lower-placement tie-break rules remain as documented above.

## Reproduce

After applying the bracket migrations, including `20261023120000_fair_group_draw_and_stage_based_home.sql`:

```sh
psql -v ON_ERROR_STOP=1 -f supabase/scripts/20261023120000_regression_group_draw_and_home_priority.sql
psql -v ON_ERROR_STOP=1 -f supabase/scripts/20261023100000_audit_uneven_bracket_counts_and_balance.sql
```
