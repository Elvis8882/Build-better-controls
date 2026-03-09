-- Prevent public RPC callers from invoking privileged bracket rebuild helpers.
-- These routines run as SECURITY DEFINER and mutate playoff structures/seeds.
revoke execute on function public.ensure_playoff_bracket(uuid) from public, anon, authenticated;
revoke execute on function public.ensure_losers_bracket(uuid) from public, anon, authenticated;

grant execute on function public.ensure_playoff_bracket(uuid) to service_role;
grant execute on function public.ensure_losers_bracket(uuid) to service_role;
