-- Ensure placement trigger executes with definer privileges and provide an explicit
-- authenticated insert policy for environments that enforce RLS on this table.

alter function public.trg_place_losers_into_losers_bracket()
  security definer
  set search_path = public;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'playoff_placement_entrants'
      and policyname = 'playoff_placement_entrants_insert_host_admin'
  ) then
    create policy playoff_placement_entrants_insert_host_admin
      on public.playoff_placement_entrants
      for insert
      to authenticated
      with check (
        exists (
          select 1
          from public.tournament_members tm
          where tm.tournament_id = playoff_placement_entrants.tournament_id
            and tm.user_id = auth.uid()
            and tm.role in ('host', 'admin')
        )
        or exists (
          select 1
          from public.profiles p
          where p.id = auth.uid()
            and p.role = 'admin'
        )
      );
  end if;
end $$;
