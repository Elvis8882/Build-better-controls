create or replace function public.trg_advance_playoff_winner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  winner uuid;
begin
  -- only on lock
  if new.locked is distinct from true then
    return new;
  end if;

  select *
  into m
  from public.matches
  where id = new.match_id;

  if m.stage <> 'PLAYOFF' then
    return new;
  end if;

  -- determine winner (no ties expected)
  if new.home_score > new.away_score then
    winner := m.home_participant_id;
  elsif new.away_score > new.home_score then
    winner := m.away_participant_id;
  else
    --return new implies no advance on tie
    return new;
  end if;

  if m.next_match_id is null or m.next_match_side is null then
    return new;
  end if;

  if m.next_match_side = 'HOME' then
    update public.matches
    set home_participant_id = winner
    where id = m.next_match_id
      and (away_participant_id is distinct from winner or home_participant_id is not null);
  else
    update public.matches
    set away_participant_id = winner
    where id = m.next_match_id
      and (home_participant_id is distinct from winner or away_participant_id is not null);
  end if;

  perform public.sync_match_identities_from_participants(m.next_match_id);
  perform public.balance_match_home_away(m.next_match_id);

  return new;
end;
$$;

create or replace function public.can_manage_match_result(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_admin()
    or public.is_host_of_match(p_match_id)
    or public.is_participant_of_match(p_match_id);
$$;

grant execute on function public.can_manage_match_result(uuid) to authenticated;

alter table if exists public.match_results enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'match_results'
      and policyname = 'match_results_insert_participant_or_host_admin'
  ) then
    create policy match_results_insert_participant_or_host_admin
    on public.match_results
    for insert
    to authenticated
    with check (public.can_manage_match_result(match_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'match_results'
      and policyname = 'match_results_update_participant_or_host_admin'
  ) then
    create policy match_results_update_participant_or_host_admin
    on public.match_results
    for update
    to authenticated
    using (public.can_manage_match_result(match_id))
    with check (public.can_manage_match_result(match_id));
  end if;
end
$$;
