declare
  m record;
  hp record;
  ap record;
begin
  select * into m from public.matches where id = p_match_id;

  if m.home_participant_id is not null then
    select user_id, guest_id into hp
    from public.tournament_participants
    where id = m.home_participant_id;
  end if;

  if m.away_participant_id is not null then
    select user_id, guest_id into ap
    from public.tournament_participants
    where id = m.away_participant_id;
  end if;

  update public.matches
  set
    home_user_id = hp.user_id,
    home_guest_id = hp.guest_id,
    away_user_id = ap.user_id,
    away_guest_id = ap.guest_id
  where id = p_match_id;
end;
