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
    where id = m.next_match_id;
  else
    update public.matches
    set away_participant_id = winner
    where id = m.next_match_id;
  end if;

  perform public.sync_match_identities_from_participants(m.next_match_id);

  return new;
end;
