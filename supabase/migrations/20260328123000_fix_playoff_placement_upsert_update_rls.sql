-- Fix RLS for playoff placement upserts.
-- The placement trigger writes with `insert ... on conflict ... do update`, which requires
-- both INSERT and UPDATE policies to pass under RLS.

alter function public.trg_place_losers_into_losers_bracket()
  security definer
  set search_path = public;

do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'playoff_placement_entrants'
      and policyname = 'playoff_placement_entrants_update_match_participant'
  ) then
    drop policy playoff_placement_entrants_update_match_participant
      on public.playoff_placement_entrants;
  end if;

  create policy playoff_placement_entrants_update_match_participant
    on public.playoff_placement_entrants
    for update
    to authenticated
    using (
      (
        playoff_placement_entrants.source_match_id is not null
        and public.can_manage_match_result(playoff_placement_entrants.source_match_id)
      )
      or exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.role = 'admin'
      )
    )
    with check (
      (
        playoff_placement_entrants.source_match_id is not null
        and public.can_manage_match_result(playoff_placement_entrants.source_match_id)
      )
      or exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.role = 'admin'
      )
    );
end $$;
