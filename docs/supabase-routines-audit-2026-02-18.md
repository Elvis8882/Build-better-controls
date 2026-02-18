# Supabase routines audit (2026-02-18)

Scope:
- Compare `supabase/routines/*.sql` against repository files changed in the last 24h.
- Cross-check routine assumptions against the provided live DB schema snapshot.

## Files changed in last 24 hours that impact routine behavior

- `supabase/routines/*.sql` (new routine bodies)
- `supabase/migrations/20260218150000_guard_matches_bracket_unique_constraint.sql`
- `src/lib/db.ts`
- Tournament UI files (`src/pages/tournaments/...`) that invoke data paths depending on routine outputs

## High-confidence issues

### 1) Preset enum drift across layers

Observed:
- Live DB check allows: `playoffs_only`, `full_with_losers`, `full_no_losers`.
- Routines use `full_with_losers` and `full_no_losers` logic.
- `src/lib/db.ts` still includes fallback compatibility with `full_tournament` and has `TournamentPreset` including both legacy and new values.

Risk:
- Depending on environment state, insert/update paths may silently fallback to `full_tournament` while routines expect `full_*_losers`, causing bracket generation path mismatch.

Recommendation:
- Standardize on one preset domain in both SQL and TypeScript.
- Remove `full_tournament` fallback from app once all envs migrated.

### 2) `matches_bracket_unique` dependency mismatch

Observed:
- `ensure_playoff_bracket.sql` and `ensure_losers_bracket.sql` use `ON CONFLICT ON CONSTRAINT matches_bracket_unique DO NOTHING`.
- Guard migration `20260218150000_guard_matches_bracket_unique_constraint.sql` intentionally skips adding this constraint when duplicates exist.

Risk:
- In any DB where guard skipped constraint creation, runtime calls to routines that reference the named constraint can fail.

Recommendation:
- Either:
  1) enforce dedup + create the constraint in all environments before routine usage; or
  2) update routines to use key-based `WHERE NOT EXISTS` inserts not requiring named constraint.

### 3) Trigger/routine deployment drift risk

Observed:
- `supabase/routines/*.sql` are routine bodies, while executable deployment source is migrations.
- If these bodies were created in git without corresponding `create or replace function` migrations/triggers in the same rollout, environments may run stale database logic.

Risk:
- Frontend can behave as if latest logic exists, while DB executes older functions/triggers.

Recommendation:
- Add explicit migrations for all current routine versions and trigger bindings.

### 4) Seeding and bracket-size assumptions can create sparse seeds

Observed:
- `ensure_playoff_bracket.sql` calculates next power of two bracket size and uses seed array indexing up to bracket size.
- For non-power-of-two participant counts, BYE auto-advance logic fills next rounds.

Risk:
- If `tournament_playoff_seeds` count diverges from participants (stale rows), seed indexing can produce unexpected null placements.

Recommendation:
- Add precondition cleanup: regenerate seeds when participant count or IDs differ from `tournament_playoff_seeds`.

### 5) Group-stage generation algorithm divergence

Observed:
- There are two generation strategies in history:
  - pairwise combinations (`generate_group_stage` in routine file)
  - round-robin circle method (`20260218090000_round_robin_group_schedule.sql` migration)

Risk:
- Environments with stale function definitions may generate different number/order of matches, causing UI inconsistencies and playoff reseed timing differences.

Recommendation:
- Confirm which strategy is canonical and migrate all envs to it with a single `create or replace function` source.

## Cross-checks against live schema snapshot

- Schema includes `matches.bracket_slot`, `next_match_id`, `next_match_side` required by new routines ✅
- Schema does **not** show unique constraint `matches_bracket_unique` on `matches` ❗
- Schema uses `tournaments.preset_id` check with `full_with_losers/full_no_losers` (legacy `full_tournament` excluded) ✅

## Priority order for remediation

1. Resolve `matches_bracket_unique` availability (or remove named-constraint dependency in routines).
2. Normalize preset values across TS + SQL.
3. Publish migration(s) that install current routine + trigger versions.
4. Verify seed persistence integrity (`tournament_playoff_seeds`) during participant changes.
