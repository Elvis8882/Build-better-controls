declare
  m record;
  winner uuid;
  v_preset text;
  v_rows_updated int;
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

  select preset_id into v_preset
  from public.tournaments
  where id = m.tournament_id;

  if m.next_match_side = 'HOME' then
    update public.matches
    set home_participant_id = winner
    where id = m.next_match_id
      and (home_participant_id is null or home_participant_id = winner)
      and away_participant_id is distinct from winner;

    get diagnostics v_rows_updated = row_count;

    -- Full tournament with losers bracket: placement semifinals can already contain
    -- a winners-semifinal loser in HOME. If so, place the advancing placement winner
    -- into AWAY when that slot is still free.
    if v_rows_updated = 0
      and v_preset = 'full_with_losers'
      and m.bracket_type = 'LOSERS' then
      update public.matches
      set away_participant_id = winner
      where id = m.next_match_id
        and away_participant_id is null
        and home_participant_id is distinct from winner;
    end if;
  else
    update public.matches
    set away_participant_id = winner
    where id = m.next_match_id
      and (away_participant_id is null or away_participant_id = winner)
      and home_participant_id is distinct from winner;

    get diagnostics v_rows_updated = row_count;

    if v_rows_updated = 0
      and v_preset = 'full_with_losers'
      and m.bracket_type = 'LOSERS' then
      update public.matches
      set home_participant_id = winner
      where id = m.next_match_id
        and home_participant_id is null
        and away_participant_id is distinct from winner;
    end if;
  end if;

  perform public.sync_match_identities_from_participants(m.next_match_id);
  perform public.balance_match_home_away(m.next_match_id);

  return new;
end;
