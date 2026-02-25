-- Restore definer execution for playoff seeding writes used by no-group presets
-- (playoffs_only and 2v2_playoffs) to avoid RLS failures when locking the last participant.
alter function public.ensure_playoff_bracket(uuid) security definer;
alter function public.ensure_playoff_bracket(uuid) set search_path = public;
