# Tournament preset contract

This file is the contract source-of-truth for tournament preset behavior across SQL routines and frontend helpers.

## Accepted persisted values (`tournaments.preset_id`)

- `playoffs_only`
- `full_with_losers`
- `full_no_losers`
- `2v2_tournament`
- `2v2_playoffs`

## Legacy value policy

- `full_tournament` is a **legacy** value.
- Contract decision: **reject legacy/unknown preset values at runtime** (no silent fallback mapping).
- Reason: all persisted legacy rows are migrated in SQL; any reappearance indicates upstream drift that must fail fast.

## Implementations bound to this contract

- Frontend/app helper: `src/lib/tournament-preset-contract.ts`
- SQL normalizer routine: `supabase/routines/normalize_tournament_preset.sql`
