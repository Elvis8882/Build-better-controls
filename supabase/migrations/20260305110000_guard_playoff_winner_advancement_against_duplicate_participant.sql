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

  select * into m from public.matches where id = new.match_id;

  if m.stage <> 'PLAYOFF' then
    return new;
  end if;

  -- determine winner (no ties expected)
  if new.home_score > new.away_score then
    winner := m.home_participant_id;
  elsif new.away_score > new.home_score then
    winner := m.away_participant_id;
  else
    return new;
  end if;

  if m.next_match_id is null or m.next_match_side is null then
    return new;
  end if;

  if m.next_match_side = 'HOME' then
    update public.matches
    set home_participant_id = winner
    where id = m.next_match_id
      and (home_participant_id is null or home_participant_id = winner)
      and away_participant_id is distinct from winner;
  else
    update public.matches
    set away_participant_id = winner
    where id = m.next_match_id
      and (away_participant_id is null or away_participant_id = winner)
      and home_participant_id is distinct from winner;
  end if;

  perform public.sync_match_identities_from_participants(m.next_match_id);
  perform public.balance_match_home_away(m.next_match_id);

  return new;
end;
$$;
