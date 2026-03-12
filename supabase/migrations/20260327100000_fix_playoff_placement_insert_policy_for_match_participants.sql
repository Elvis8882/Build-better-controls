-- Allow playoff placement trigger inserts when locked by match participants.
-- Keep trigger execution elevated for RLS-protected environments.
alter function public.trg_place_losers_into_losers_bracket()
  security definer
  set search_path = public;

-- This complements host/admin access and prevents RLS failures during playoff result locking.

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'playoff_placement_entrants'
      and policyname = 'playoff_placement_entrants_insert_match_participant'
  ) then
    create policy playoff_placement_entrants_insert_match_participant
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
        or exists (
          select 1
          from public.matches mx
          join public.tournament_participants tp
            on tp.id in (mx.home_participant_id, mx.away_participant_id)
          where mx.id = playoff_placement_entrants.source_match_id
            and mx.tournament_id = playoff_placement_entrants.tournament_id
            and tp.user_id = auth.uid()
        )
      );
  end if;
end $$;
