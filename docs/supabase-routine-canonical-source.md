# Supabase routine canonical source of truth

## Canonical implementation path

For function behavior, the **canonical source of truth is migration history** in `supabase/migrations/`.

- The latest migration (by timestamped filename) that runs `CREATE OR REPLACE FUNCTION public.<name>(...)` defines the active implementation used by the database.
- Files in `supabase/routines/*.sql` are body snapshots for readability and review, and must match that latest migration definition exactly.

## Debugging guidance

When debugging routine behavior:

1. Start from the latest migration that redefines the target function (canonical runtime behavior).
2. Use the routine snapshot in `supabase/routines/` as a quick local reference.
3. If they diverge, treat it as drift and fix snapshots to match migrations (or add a new migration if behavior is changing intentionally).

## Drift enforcement

CI enforces this invariant by running `scripts/check_supabase_routine_drift.py`, which compares each routine snapshot body against the newest migration definition and fails with explicit function names when drift exists.
