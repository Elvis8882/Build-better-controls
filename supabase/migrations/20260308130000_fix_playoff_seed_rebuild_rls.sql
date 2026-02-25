-- ensure playoff bracket rebuilds run with definer privileges so participant lock-in
-- does not fail RLS when writing tournament_playoff_seeds.
alter function public.ensure_playoff_bracket(uuid) security definer;
alter function public.ensure_playoff_bracket(uuid) set search_path = public, pg_temp;

-- called from ensure_playoff_bracket; keep helper aligned to avoid mixed invoker/definer chains.
alter function public.ensure_losers_bracket(uuid) security definer;
alter function public.ensure_losers_bracket(uuid) set search_path = public, pg_temp;
