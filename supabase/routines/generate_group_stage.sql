declare
  v_group_count int;
  v_participants int;
  v_codes text[] := array['A','B','C','D'];
  v_i int;
  r record;
  g record;
  p1 record;
  p2 record;
begin
  select count(*) into v_participants
  from public.tournament_participants
  where tournament_id = p_tournament_id;

  if v_participants < 3 then
    raise exception 'Need at least 3 participants for group stage';
  end if;

  select coalesce(group_count, 1) into v_group_count
  from public.tournaments
  where id = p_tournament_id;

  v_group_count := greatest(1, least(v_group_count, 4));

  -- enforce min 3 per group by reducing groups
  while v_group_count > 1 and v_participants < v_group_count * 3 loop
    v_group_count := v_group_count - 1;
  end loop;

  -- enforce max 6 per group by increasing groups up to 4
  while v_group_count < 4 and v_participants > v_group_count * 6 loop
    v_group_count := v_group_count + 1;
  end loop;

  if v_participants > v_group_count * 6 then
    raise exception 'Too many participants (%) for max 6 per group with % groups', v_participants, v_group_count;
  end if;

  -- wipe previous groups + group matches
  delete from public.tournament_group_members
   where group_id in (select id from public.tournament_groups where tournament_id = p_tournament_id);

  delete from public.tournament_groups
   where tournament_id = p_tournament_id;

  delete from public.matches
   where tournament_id = p_tournament_id and stage = 'GROUP';

  -- create groups
  for v_i in 1..v_group_count loop
    insert into public.tournament_groups(tournament_id, group_code)
    values (p_tournament_id, v_codes[v_i]);
  end loop;

  -- distribute participants randomly round-robin across groups
  v_i := 1;
  for r in
    select id
    from public.tournament_participants
    where tournament_id = p_tournament_id
    order by random()
  loop
    insert into public.tournament_group_members(group_id, participant_id)
    select g.id, r.id
    from public.tournament_groups g
    where g.tournament_id = p_tournament_id
      and g.group_code = v_codes[v_i];

    v_i := v_i + 1;
    if v_i > v_group_count then v_i := 1; end if;
  end loop;

  -- create round-robin matches inside each group
  for g in
    select id
    from public.tournament_groups
    where tournament_id = p_tournament_id
  loop
    for p1 in
      select participant_id
      from public.tournament_group_members
      where group_id = g.id
      order by participant_id
    loop
      for p2 in
        select participant_id
        from public.tournament_group_members
        where group_id = g.id
          and participant_id > p1.participant_id
        order by participant_id
      loop
        insert into public.matches(
          tournament_id,
          stage,
          round,
          home_participant_id,
          away_participant_id
        )
        values (
          p_tournament_id,
          'GROUP',
          1,
          p1.participant_id,
          p2.participant_id
        )
        returning id into r;

        perform public.sync_match_identities_from_participants(r.id);
      end loop;
    end loop;
  end loop;

  -- keep tournament stage in GROUP until group matches are finished
  update public.tournaments
  set stage = 'GROUP'
  where id = p_tournament_id;
end;
