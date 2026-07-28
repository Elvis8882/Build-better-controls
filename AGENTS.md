# Repository guide for agents

## Purpose

This repository is **NHL Enthusiast Club**, a Supabase-backed tournament manager derived from Slash Admin. The active product is the hockey competition experience under `src/pages/main`, `src/pages/tournaments`, `src/auth`, and `src/lib`; generic Slash Admin screens may remain as supporting or legacy code.

## Architecture

- `src/pages/tournaments/` owns tournament creation, group stages, brackets, standings, and format-specific UI.
- `src/lib/db.ts` is the main typed data-access layer. Keep database calls centralized where practical.
- `src/lib/tournament-preset-contract.ts`, `src/pages/tournaments/preset-flow.ts`, and `docs/tournament-preset-contract.md` describe shared preset behavior.
- `src/theme/` and `src/global.css` define the light/dark theme and palette. Prefer tokens and semantic Tailwind classes over hard-coded colors.
- `supabase/migrations/` is the ordered database history; never rewrite an already-applied migration. Add a timestamped migration instead.
- `supabase/routines/` is the canonical source for the stored routines listed in `docs/supabase-routine-canonical-source.md`. Keep routine definitions and their migration copies synchronized.
- `supabase/scripts/` contains database audits and regression fixtures.

## Working conventions

- Use Node 20 and pnpm; do not create npm or Yarn lockfiles.
- Follow the existing TypeScript style: tabs, double quotes, and a 120-column target. Biome is the formatter and linter.
- Use the `@/` alias for source imports and shared primitives from `src/ui/` before introducing another component abstraction.
- Do not wrap imports in `try`/`catch` blocks.
- Preserve authentication, row-level-security, and role checks. Never put a Supabase service-role key in client code or a `VITE_*` variable.
- Treat locked results and closed tournaments as immutable unless a requirement explicitly changes that contract.
- Keep changes focused. Do not remove inherited Slash Admin infrastructure solely because it is not part of the primary navigation.

## Database changes

1. Add a new, chronologically named file under `supabase/migrations/`.
2. If a canonical routine changes, update its file under `supabase/routines/` and follow `docs/supabase-routine-canonical-source.md`.
3. Add or update a focused SQL regression fixture when bracket generation, seeding, progression, placement, or locking changes.
4. Run `pnpm check:supabase-routines` before committing.

Avoid editing `supabase/combined_tournament_updates.sql` as a shortcut for a migration. Make authorization intent explicit for security-definer functions and RPC grants.

## Checks

Run the smallest relevant checks during development, then the full applicable set before handoff:

```bash
pnpm exec biome check .
pnpm exec tsc --noEmit
pnpm build
pnpm check:supabase-routines
```

Focused TypeScript tests can be run with:

```bash
pnpm exec tsx --test <test-file>
```

SQL regression scripts require a configured Supabase/PostgreSQL environment; state clearly when they were not run.

## Documentation and commits

- Update README or contract documentation whenever setup, behavior, or contributor workflow changes.
- Preserve the MIT license and the original Slash Admin/d3george attribution.
- Use Conventional Commit subjects (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, and so on); commitlint enforces them.
- In handoff notes, call out migrations, environment requirements, and checks that could not be run.
