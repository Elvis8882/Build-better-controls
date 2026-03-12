-- The full_with_losers playoff graph rebuild can exceed default statement timeout,
-- especially on the final group-stage lock when the full bracket is generated.
-- Ensure the core builder function always runs without statement timeout.
alter function public.ensure_playoff_bracket(uuid)
set statement_timeout = '0';
