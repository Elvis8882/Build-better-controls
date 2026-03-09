-- Re-allow authenticated tournament flows to rebuild playoff trees after lock events.
-- ensure_playoff_bracket runs as SECURITY INVOKER, so RLS still applies to callers.
grant execute on function public.ensure_playoff_bracket(uuid) to authenticated;
grant execute on function public.ensure_losers_bracket(uuid) to authenticated;
