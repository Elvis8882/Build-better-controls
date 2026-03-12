-- Align playoff placement insert authorization with match result locking permissions.
-- This prevents RLS failures when non-host participants lock playoff matches.

do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'playoff_placement_entrants'
      and policyname = 'playoff_placement_entrants_insert_match_participant'
  ) then
    drop policy playoff_placement_entrants_insert_match_participant
      on public.playoff_placement_entrants;
  end if;

  create policy playoff_placement_entrants_insert_match_participant
    on public.playoff_placement_entrants
    for insert
    to authenticated
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
