-- Ensure playoff routines can store routing metadata on matches.
-- Required by full_with_losers BYE-aware losers routing and GF tagging.
alter table public.matches
  add column if not exists metadata jsonb not null default '{}'::jsonb;
