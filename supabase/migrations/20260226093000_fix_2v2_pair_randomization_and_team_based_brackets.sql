create or replace function public.generate_group_stage(p_tournament_id uuid)
returns void
language plpgsql
as $$
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
  v_candidate_home uuid;
  v_candidate_away uuid;
  v_diff_home int;
  v_diff_away int;
  v_score_a int;
  v_score_b int;
  v_team_based boolean := false;
begin
  select coalesce(group_count,1), (preset_id in ('2v2_tournament','2v2_playoffs'))
  into v_group_count, v_team_based
  from public.tournaments
  where id = p_tournament_id;

  delete from public.tournament_group_members where group_id in (select id from public.tournament_groups where tournament_id = p_tournament_id);
  delete from public.tournament_groups where tournament_id = p_tournament_id;
  delete from public.matches where tournament_id = p_tournament_id and stage = 'GROUP';

  for v_group_index in 1..v_group_count loop
    insert into public.tournament_groups(tournament_id, group_code)
    values (p_tournament_id, v_codes[v_group_index]);
  end loop;

  v_group_index := 1;
  for v_participant in
    with seeded_participants as (
      select tp.id, tp.created_at
      from public.tournament_participants tp
      where tp.tournament_id = p_tournament_id
        and (
          not v_team_based
          or tp.id in (
            select distinct on (p.team_id) p.id
            from public.tournament_participants p
            where p.tournament_id = p_tournament_id
              and p.team_id is not null
            order by p.team_id, p.created_at asc, p.id asc
          )
        )
    )
    select id
    from seeded_participants
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

    create temporary table if not exists tmp_group_home_away_balance(
      participant_id uuid primary key,
      home_count int not null default 0,
      away_count int not null default 0
    ) on commit drop;

    truncate table tmp_group_home_away_balance;
    insert into tmp_group_home_away_balance(participant_id)
    select pid
    from unnest(v_slots) as u(pid)
    where pid is not null;

    for v_round in 1..(v_slot_count - 1) loop
      for v_pair in 1..(v_slot_count / 2) loop
        if mod(v_round + v_pair, 2) = 0 then
          v_candidate_home := v_working[v_pair];
          v_candidate_away := v_working[v_slot_count - v_pair + 1];
        else
          v_candidate_home := v_working[v_slot_count - v_pair + 1];
          v_candidate_away := v_working[v_pair];
        end if;

        v_home_id := v_candidate_home;
        v_away_id := v_candidate_away;

        if v_home_id is not null and v_away_id is not null then
          select coalesce(home_count - away_count, 0) into v_diff_home
          from tmp_group_home_away_balance
          where participant_id = v_home_id;

          select coalesce(home_count - away_count, 0) into v_diff_away
          from tmp_group_home_away_balance
          where participant_id = v_away_id;

          v_score_a := abs(v_diff_home + 1) + abs(v_diff_away - 1);
          v_score_b := abs(v_diff_home - 1) + abs(v_diff_away + 1);

          if v_score_b < v_score_a then
            v_home_id := v_candidate_away;
            v_away_id := v_candidate_home;
          end if;
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

          update tmp_group_home_away_balance
          set home_count = home_count + 1
          where participant_id = v_home_id;

          update tmp_group_home_away_balance
          set away_count = away_count + 1
          where participant_id = v_away_id;
        end if;
      end loop;

      v_working := array[v_working[1], v_working[v_slot_count]] || v_working[2:v_slot_count - 1];
    end loop;
  end loop;
end;
$$;

create or replace function public.ensure_playoff_bracket(p_tournament_id uuid)
returns void
language plpgsql
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
  v_team_based boolean := false;
begin
  select preset_id, (preset_id in ('2v2_tournament','2v2_playoffs'))
  into v_preset, v_team_based
  from public.tournaments
  where id = p_tournament_id;

  select exists (
    select 1
    from public.matches m
    join public.match_results mr on mr.match_id = m.id
    where m.tournament_id = p_tournament_id
      and m.stage = 'PLAYOFF'
      and mr.locked = true
  ) into v_any_playoff_locked;

  if v_team_based then
    select count(*) into v_n
    from (
      select distinct on (tp.team_id) tp.id
      from public.tournament_participants tp
      where tp.tournament_id = p_tournament_id
        and tp.team_id is not null
      order by tp.team_id, tp.created_at asc, tp.id asc
    ) seeded;
  else
    select count(*) into v_n
    from public.tournament_participants
    where tournament_id = p_tournament_id;
  end if;

  if v_n < 3 then
    return;
  end if;

  v_s := 1;
  while v_s < v_n loop v_s := v_s * 2; end loop;
  v_rounds := (log(v_s)::numeric / log(2)::numeric)::int;

  for v_round in 1..v_rounds loop
    v_matches_in_round := v_s / (2^v_round);
    for v_slot in 1..v_matches_in_round loop
      insert into public.matches(
        tournament_id, stage, bracket_type, round, bracket_slot
      )
      select
        p_tournament_id, 'PLAYOFF', 'WINNERS', v_round, v_slot
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
      if v_team_based then
        insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
        select p_tournament_id,
               row_number() over (order by random())::int as seed,
               id
        from (
          select distinct on (tp.team_id) tp.id
          from public.tournament_participants tp
          where tp.tournament_id = p_tournament_id
            and tp.team_id is not null
          order by tp.team_id, tp.created_at asc, tp.id asc
        ) seeded;
      else
        insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
        select p_tournament_id,
               row_number() over (order by random())::int as seed,
               id
        from public.tournament_participants
        where tournament_id = p_tournament_id;
      end if;
    end if;

    if (select count(*) from public.tournament_playoff_seeds where tournament_id = p_tournament_id) <> v_n
       or exists (
         select 1
         from public.tournament_playoff_seeds s
         left join public.tournament_participants tp
           on tp.id = s.participant_id and tp.tournament_id = p_tournament_id
         where s.tournament_id = p_tournament_id
           and (
            tp.id is null
            or (v_team_based and (tp.team_id is null or exists (
              select 1
              from public.tournament_participants dup
              where dup.tournament_id = p_tournament_id
                and dup.team_id = tp.team_id
                and (dup.created_at < tp.created_at or (dup.created_at = tp.created_at and dup.id < tp.id))
            )))
           )
       )
    then
      delete from public.tournament_playoff_seeds where tournament_id = p_tournament_id;
      if v_team_based then
        insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
        select p_tournament_id,
               row_number() over (order by random())::int as seed,
               id
        from (
          select distinct on (tp.team_id) tp.id
          from public.tournament_participants tp
          where tp.tournament_id = p_tournament_id
            and tp.team_id is not null
          order by tp.team_id, tp.created_at asc, tp.id asc
        ) seeded;
      else
        insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
        select p_tournament_id,
               row_number() over (order by random())::int as seed,
               id
        from public.tournament_participants
        where tournament_id = p_tournament_id;
      end if;
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
    perform public.balance_match_home_away(v_mid);
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
end;
$$;
