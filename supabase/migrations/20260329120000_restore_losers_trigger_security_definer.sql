-- Restore elevated execution for placement trigger after function replacement.
-- `create or replace function` resets SECURITY DEFINER attributes unless re-applied,
-- which can surface RLS errors on playoff_placement_entrants during match locking.
alter function public.trg_place_losers_into_losers_bracket()
  security definer
  set search_path = public;
