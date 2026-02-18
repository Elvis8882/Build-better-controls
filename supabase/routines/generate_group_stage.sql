declare
  v_group_count int;
  v_codes text[] := array['A','B','C','D'];
  v_group_index int := 1;
  v_group record;
  v_participant record;
  v_slots uuid[];
  v_working uuid[];
  v_slot_count int;
  v_round int;
  v_pair int;
  v_home_id uuid;
  v_away_id uuid;
begin
  select coalesce(group_count,1) into v_group_count from public.tournaments where id = p_tournament_id;

  delete from public.tournament_group_members where group_id in (select id from public.tournament_groups where tournament_id = p_tournament_id);
  delete from public.tournament_groups where tournament_id = p_tournament_id;
  delete from public.matches where tournament_id = p_tournament_id and stage = 'GROUP';

  for v_group_index in 1..v_group_count loop
    insert into public.tournament_groups(tournament_id, group_code)
    values (p_tournament_id, v_codes[v_group_index]);
  end loop;

  v_group_index := 1;
  for v_participant in
    select id
    from public.tournament_participants
    where tournament_id = p_tournament_id
    order by created_at asc, id asc
  loop
    insert into public.tournament_group_members(group_id, participant_id)
    select id, v_participant.id
    from public.tournament_groups
    where tournament_id = p_tournament_id and group_code = v_codes[v_group_index];

    v_group_index := v_group_index + 1;
    if v_group_index > v_group_count then
      v_group_index := 1;
    end if;
  end loop;

  for v_group in
    select id
    from public.tournament_groups
    where tournament_id = p_tournament_id
    order by group_code asc
  loop
    select array_agg(participant_id order by participant_id)
    into v_slots
    from public.tournament_group_members
    where group_id = v_group.id;

    if v_slots is null or array_length(v_slots, 1) < 2 then
      continue;
    end if;

    if mod(array_length(v_slots, 1), 2) = 1 then
      v_slots := array_append(v_slots, null);
    end if;

    v_working := v_slots;
    v_slot_count := array_length(v_working, 1);

    for v_round in 1..(v_slot_count - 1) loop
      for v_pair in 1..(v_slot_count / 2) loop
        if mod(v_round + v_pair, 2) = 0 then
          v_home_id := v_working[v_pair];
          v_away_id := v_working[v_slot_count - v_pair + 1];
        else
          v_home_id := v_working[v_slot_count - v_pair + 1];
          v_away_id := v_working[v_pair];
        end if;

        if v_home_id is not null and v_away_id is not null then
          insert into public.matches(
            tournament_id,
            home_participant_id,
            away_participant_id,
            home_user_id,
            away_user_id,
            home_guest_id,
            away_guest_id,
            round,
            stage
          )
          select
            p_tournament_id,
            hp.id,
            ap.id,
            hp.user_id,
            ap.user_id,
            hp.guest_id,
            ap.guest_id,
            v_round,
            'GROUP'
          from public.tournament_participants hp
          join public.tournament_participants ap on ap.id = v_away_id
          where hp.id = v_home_id;
        end if;
      end loop;

      v_working := array[v_working[1], v_working[v_slot_count]] || v_working[2:v_slot_count - 1];
    end loop;
  end loop;
end;
