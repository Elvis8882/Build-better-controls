-- Prevent cross-tenant bracket tampering by ensuring caller RLS policies apply.
-- These RPCs are invoked from the client and must not bypass row-level security.

alter function public.generate_group_stage(uuid) security invoker;
alter function public.ensure_playoff_bracket(uuid) security invoker;
