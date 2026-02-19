create or replace function public.ensure_losers_bracket(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preset text;
  v_n int;
  v_s int;
begin
  select preset_id into v_preset from public.tournaments where id = p_tournament_id;
  if v_preset is null then
    return;
  end if;

  select count(*) into v_n from public.tournament_participants where tournament_id = p_tournament_id;
  if v_n < 4 then
    return;
  end if;

  v_s := 1;
  while v_s < v_n loop v_s := v_s * 2; end loop;

  insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
  select p_tournament_id, 'PLAYOFF', 'LOSERS', 1, 1
  where not exists (
    select 1
    from public.matches mx
    where mx.tournament_id = p_tournament_id
      and mx.stage = 'PLAYOFF'
      and mx.bracket_type = 'LOSERS'
      and mx.round = 1
      and mx.bracket_slot = 1
  );

  if v_preset = 'full_with_losers' and v_s >= 8 then
    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
    select p_tournament_id, 'PLAYOFF', 'LOSERS', payload.round, payload.bracket_slot
    from (values (1,2), (1,3), (2,1), (2,2)) as payload(round, bracket_slot)
    where not exists (
      select 1
      from public.matches mx
      where mx.tournament_id = p_tournament_id
        and mx.stage = 'PLAYOFF'
        and mx.bracket_type = 'LOSERS'
        and mx.round = payload.round
        and mx.bracket_slot = payload.bracket_slot
    );

    update public.matches
    set next_match_id = (
      select id from public.matches where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=2 and bracket_slot=1
    ), next_match_side='HOME'
    where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=1 and bracket_slot=2;

    update public.matches
    set next_match_id = (
      select id from public.matches where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=2 and bracket_slot=1
    ), next_match_side='AWAY'
    where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=1 and bracket_slot=3;
  end if;
end;
$$;

create or replace function public.ensure_playoff_bracket(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_preset text;
  v_n int;
  v_s int;
  v_rounds int;
  v_round int;
  v_slot int;
  v_matches_in_round int;
  v_seeded uuid[];
  v_has_group boolean;
  v_any_playoff_locked boolean;
  v_mid uuid;
  v_parent uuid;
  v_parent_side text;
  v_home uuid;
  v_away uuid;
  v_seed_positions int[];
  v_next_positions int[];
  v_pos int;
begin
  select preset_id into v_preset from public.tournaments where id = p_tournament_id;

  select exists (
    select 1
    from public.matches m
    join public.match_results mr on mr.match_id = m.id
    where m.tournament_id = p_tournament_id
      and m.stage = 'PLAYOFF'
      and mr.locked = true
  ) into v_any_playoff_locked;

  select count(*) into v_n
  from public.tournament_participants
  where tournament_id = p_tournament_id;

  if v_n < 3 then
    return;
  end if;

  v_s := 1;
  while v_s < v_n loop v_s := v_s * 2; end loop;
  v_rounds := (log(v_s)::numeric / log(2)::numeric)::int;

  for v_round in 1..v_rounds loop
    v_matches_in_round := v_s / (2^v_round);
    for v_slot in 1..v_matches_in_round loop
      insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
      select p_tournament_id, 'PLAYOFF', 'WINNERS', v_round, v_slot
      where not exists (
        select 1
        from public.matches mx
        where mx.tournament_id = p_tournament_id
          and mx.stage = 'PLAYOFF'
          and mx.bracket_type = 'WINNERS'
          and mx.round = v_round
          and mx.bracket_slot = v_slot
      );
    end loop;
  end loop;

  for v_round in 1..(v_rounds-1) loop
    v_matches_in_round := v_s / (2^v_round);
    for v_slot in 1..v_matches_in_round loop
      select id into v_mid
      from public.matches
      where tournament_id = p_tournament_id
        and stage='PLAYOFF' and bracket_type='WINNERS'
        and round=v_round and bracket_slot=v_slot;

      select id into v_parent
      from public.matches
      where tournament_id = p_tournament_id
        and stage='PLAYOFF' and bracket_type='WINNERS'
        and round=(v_round+1) and bracket_slot=ceil(v_slot/2.0)::int;

      v_parent_side := case when (v_slot % 2)=1 then 'HOME' else 'AWAY' end;

      update public.matches
      set next_match_id = v_parent,
          next_match_side = v_parent_side
      where id = v_mid;
    end loop;
  end loop;

  perform public.ensure_losers_bracket(p_tournament_id);

  if v_any_playoff_locked then
    return;
  end if;

  select exists (
    select 1
    from public.tournament_groups
    where tournament_id = p_tournament_id
  ) into v_has_group;

  if v_has_group then
    select array_agg(participant_id order by seed asc) into v_seeded
    from public.v_playoff_seeds
    where tournament_id = p_tournament_id;
  else
    if not exists (select 1 from public.tournament_playoff_seeds where tournament_id = p_tournament_id) then
      insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
      select p_tournament_id, row_number() over (order by random())::int as seed, id
      from public.tournament_participants
      where tournament_id = p_tournament_id;
    end if;

    if (select count(*) from public.tournament_playoff_seeds where tournament_id = p_tournament_id) <> v_n
       or exists (
         select 1
         from public.tournament_playoff_seeds s
         left join public.tournament_participants tp
           on tp.id = s.participant_id and tp.tournament_id = p_tournament_id
         where s.tournament_id = p_tournament_id
           and tp.id is null
       )
    then
      delete from public.tournament_playoff_seeds where tournament_id = p_tournament_id;
      insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
      select p_tournament_id, row_number() over (order by random())::int as seed, id
      from public.tournament_participants
      where tournament_id = p_tournament_id;
    end if;

    select array_agg(participant_id order by seed asc) into v_seeded
    from public.tournament_playoff_seeds
    where tournament_id = p_tournament_id;
  end if;

  if v_seeded is null then
    return;
  end if;

  v_seed_positions := array[1, 2];
  while array_length(v_seed_positions, 1) < v_s loop
    v_next_positions := '{}'::int[];
    foreach v_pos in array v_seed_positions loop
      v_next_positions := array_append(v_next_positions, v_pos);
      v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
    end loop;
    v_seed_positions := v_next_positions;
  end loop;

  v_matches_in_round := v_s / 2;

  for v_slot in 1..v_matches_in_round loop
    v_home := case
      when v_seed_positions[(v_slot - 1) * 2 + 1] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 1]]
      else null
    end;
    v_away := case
      when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 2]]
      else null
    end;

    update public.matches
    set home_participant_id = v_home,
        away_participant_id = v_away
    where tournament_id = p_tournament_id
      and stage='PLAYOFF' and bracket_type='WINNERS'
      and round=1 and bracket_slot=v_slot;

    select id into v_mid
    from public.matches
    where tournament_id = p_tournament_id
      and stage='PLAYOFF' and bracket_type='WINNERS'
      and round=1 and bracket_slot=v_slot;

    perform public.sync_match_identities_from_participants(v_mid);
  end loop;

  update public.matches
  set home_participant_id = null,
      away_participant_id = null,
      home_user_id = null,
      away_user_id = null,
      home_guest_id = null,
      away_guest_id = null
  where tournament_id = p_tournament_id
    and stage='PLAYOFF' and bracket_type='WINNERS'
    and round > 1;

  v_round := 1;
  for v_slot in 1..(v_s / 2) loop
    select id, home_participant_id, away_participant_id, next_match_id, next_match_side
    into r
    from public.matches
    where tournament_id = p_tournament_id
      and stage='PLAYOFF' and bracket_type='WINNERS'
      and round=v_round and bracket_slot=v_slot;

    if r.next_match_id is not null then
      if r.home_participant_id is not null and r.away_participant_id is null then
        if r.next_match_side = 'HOME' then
          update public.matches set home_participant_id = r.home_participant_id where id = r.next_match_id and home_participant_id is null;
        else
          update public.matches set away_participant_id = r.home_participant_id where id = r.next_match_id and away_participant_id is null;
        end if;
      elsif r.away_participant_id is not null and r.home_participant_id is null then
        if r.next_match_side = 'HOME' then
          update public.matches set home_participant_id = r.away_participant_id where id = r.next_match_id and home_participant_id is null;
        else
          update public.matches set away_participant_id = r.away_participant_id where id = r.next_match_id and away_participant_id is null;
        end if;
      end if;
    end if;
  end loop;

  for r in
    select id from public.matches
    where tournament_id = p_tournament_id and stage='PLAYOFF' and bracket_type='WINNERS'
  loop
    perform public.sync_match_identities_from_participants(r.id);
  end loop;

  perform public.ensure_losers_bracket(p_tournament_id);
end;
$$;

create or replace function public.trg_place_losers_into_losers_bracket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

  if (select preset_id from public.tournaments where id = m.tournament_id) is null then
    return new;
  end if;

  perform public.ensure_losers_bracket(m.tournament_id);

  if new.home_score > new.away_score then
    loser := m.away_participant_id;
  elsif new.away_score > new.home_score then
    loser := m.home_participant_id;
  else
    return new;
  end if;

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
$$;
