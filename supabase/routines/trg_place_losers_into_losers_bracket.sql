declare
  m record;
  loser uuid;
  target uuid;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'PLAYOFF' or m.bracket_type <> 'WINNERS' then
    return new;
  end if;

  -- only for tournaments that expose playoffs
  if (select preset_id from public.tournaments where id = m.tournament_id) is null then
    return new;
  end if;

  perform public.ensure_losers_bracket(m.tournament_id);

  -- determine loser
  if new.home_score > new.away_score then
    loser := m.away_participant_id;
  elsif new.away_score > new.home_score then
    loser := m.home_participant_id;
  else
    return new;
  end if;

  -- semifinal losers -> 3rd place match (LOSERS round 1 slot 1)
  -- semifinals are typically the round just before final; here we approximate by: next_match_id is final match and that final has no next_match_id
  if m.next_match_id is not null
     and (select next_match_id from public.matches where id = m.next_match_id) is null
  then
    select id into target
    from public.matches
    where tournament_id = m.tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
      and round=1 and bracket_slot=1;

    if target is not null then
      update public.matches
      set home_participant_id = coalesce(home_participant_id, loser),
          away_participant_id = case when home_participant_id is not null and away_participant_id is null then loser else away_participant_id end
      where id = target;

      perform public.sync_match_identities_from_participants(target);
    end if;

    return new;
  end if;

  -- quarterfinal losers (simple fill): put into LOSERS round 1 slot 2 then 3
  -- this only applies when extra placement matches exist (full_with_losers)
  -- quarterfinals are round where winners feed into semifinals; approximate by m.next_match_id exists and that next_match has a next_match_id (i.e., not final)
  if m.next_match_id is not null
     and (select preset_id from public.tournaments where id = m.tournament_id) = 'full_with_losers'
  then
    select id into target
    from public.matches
    where tournament_id = m.tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
      and round=1 and bracket_slot=2
      and (home_participant_id is null or away_participant_id is null)
    limit 1;

    if target is null then
      select id into target
      from public.matches
      where tournament_id = m.tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
        and round=1 and bracket_slot=3
        and (home_participant_id is null or away_participant_id is null)
      limit 1;
    end if;

    if target is not null then
      update public.matches
      set home_participant_id = coalesce(home_participant_id, loser),
          away_participant_id = case when home_participant_id is not null and away_participant_id is null then loser else away_participant_id end
      where id = target;

      perform public.sync_match_identities_from_participants(target);
    end if;
  end if;

  return new;
end;
