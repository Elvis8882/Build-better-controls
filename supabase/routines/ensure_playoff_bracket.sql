declare
	r record;
  v_preset text;
  v_status text;
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
  v_is_full_with_losers boolean := false;
  v_leaf_alive int[];
  v_next_alive int[];
  v_wb_drop_counts int[] := '{}'::int[];
  v_child_a int;
  v_child_b int;
  v_drop_matches int;
  v_lb_prev_winners int := 0;
  v_lb_entrants int;
  v_lb_round int;
  v_lb_round_count int := 0;
  v_lb_matches int[] := '{}'::int[];
  v_drop_round_by_wb int[] := '{}'::int[];
  v_from_round int;
  v_from_slot int;
  v_to_slot int;
  v_gf1_round int;
begin
  -- Developer note:
  -- Group Stage qualification/seeding flow is intentionally preserved.
  -- Playoff generation for full_with_losers is rebuilt as one generalized
  -- double-elimination engine (4..16 entrants) with BYE-aware losers routing.

  select preset_id, status, public.preset_is_team_based(preset_id), public.preset_is_full_with_losers(preset_id)
  into v_preset, v_status, v_team_based, v_is_full_with_losers
  from public.tournaments
  where id = p_tournament_id;

  if lower(coalesce(v_status, '')) = 'closed' then
    raise exception 'Cannot modify playoff bracket for closed tournament'
      using errcode = '55000';
  end if;

  select exists (
    select 1
    from public.matches m
    join public.match_results mr on mr.match_id = m.id
    where m.tournament_id = p_tournament_id
      and m.stage = 'PLAYOFF'
      and mr.locked = true
  ) into v_any_playoff_locked;

  -- Freeze playoff bracket structure and participant assignments once any playoff result is locked.
  if v_any_playoff_locked then
    return;
  end if;

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

  -- Ensure winners-bracket graph exists for all playoff-capable presets.
  -- Non-full-with-losers modes depend on this graph for normal single-elim flow.
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

  -- Generalized double-elimination graph for full_with_losers presets.
  if v_is_full_with_losers and v_n >= 4 and v_n <= 16 then
    delete from public.playoff_placement_entrants where tournament_id = p_tournament_id;
    delete from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS';

    -- Compute real loser drops from each winners round using seeded occupancy,
    -- so odd-size tournaments do not materialize unreachable placement nodes.
    v_seed_positions := array[1, 2];
    while array_length(v_seed_positions, 1) < v_s loop
      v_next_positions := '{}'::int[];
      foreach v_pos in array v_seed_positions loop
        v_next_positions := array_append(v_next_positions, v_pos);
        v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
      end loop;
      v_seed_positions := v_next_positions;
    end loop;

    v_leaf_alive := '{}'::int[];
    for v_pos in 1..v_s loop
      if v_seed_positions[v_pos] <= v_n then
        v_leaf_alive := array_append(v_leaf_alive, 1);
      else
        v_leaf_alive := array_append(v_leaf_alive, 0);
      end if;
    end loop;

    for v_round in 1..v_rounds loop
      v_next_alive := '{}'::int[];
      v_drop_matches := 0;

      for v_slot in 1..(array_length(v_leaf_alive, 1) / 2) loop
        v_child_a := v_leaf_alive[(v_slot * 2) - 1];
        v_child_b := v_leaf_alive[v_slot * 2];

        if v_child_a = 1 and v_child_b = 1 then
          v_drop_matches := v_drop_matches + 1;
          v_next_alive := array_append(v_next_alive, 1);
        elsif v_child_a = 1 or v_child_b = 1 then
          v_next_alive := array_append(v_next_alive, 1);
        else
          v_next_alive := array_append(v_next_alive, 0);
        end if;
      end loop;

      v_wb_drop_counts := array_append(v_wb_drop_counts, v_drop_matches);
      v_leaf_alive := v_next_alive;
    end loop;

    v_lb_entrants := coalesce(v_wb_drop_counts[1], 0);
    if v_lb_entrants > 0 then
      v_lb_round_count := v_lb_round_count + 1;
      v_lb_round := v_lb_round_count;
      v_lb_matches := array_append(v_lb_matches, ceil(v_lb_entrants / 2.0)::int);
      v_drop_round_by_wb := array_append(v_drop_round_by_wb, v_lb_round);
      v_lb_prev_winners := ceil(v_lb_entrants / 2.0)::int;
    end if;

    for v_round in 2..v_rounds loop
      v_lb_entrants := coalesce(v_lb_prev_winners, 0) + coalesce(v_wb_drop_counts[v_round], 0);
      if v_lb_entrants > 0 then
        v_lb_round_count := v_lb_round_count + 1;
        v_lb_round := v_lb_round_count;
        v_lb_matches := array_append(v_lb_matches, ceil(v_lb_entrants / 2.0)::int);
        v_drop_round_by_wb := array_append(v_drop_round_by_wb, v_lb_round);
        v_lb_prev_winners := ceil(v_lb_entrants / 2.0)::int;
      end if;

      if v_round < v_rounds and v_lb_prev_winners > 1 then
        v_lb_round_count := v_lb_round_count + 1;
        v_lb_round := v_lb_round_count;
        v_lb_matches := array_append(v_lb_matches, ceil(v_lb_prev_winners / 2.0)::int);
        v_lb_prev_winners := ceil(v_lb_prev_winners / 2.0)::int;
      end if;
    end loop;

    if v_lb_round_count = 0 then
      v_lb_round_count := 1;
      v_lb_matches := array_append(v_lb_matches, 1);
      v_drop_round_by_wb := array_append(v_drop_round_by_wb, 1);
    end if;

    for v_round in 1..v_lb_round_count loop
      for v_slot in 1..v_lb_matches[v_round] loop
        insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
        select p_tournament_id, 'PLAYOFF', 'LOSERS', v_round, v_slot
        where not exists (
          select 1
          from public.matches mx
          where mx.tournament_id = p_tournament_id
            and mx.stage = 'PLAYOFF'
            and mx.bracket_type = 'LOSERS'
            and mx.round = v_round
            and mx.bracket_slot = v_slot
        );
      end loop;
    end loop;

    -- GF1 only; GF2 is created lazily only if reset is required.
    v_gf1_round := v_lb_round_count + 1;
    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot, metadata)
    select p_tournament_id, 'PLAYOFF', 'LOSERS', v_gf1_round, 1, jsonb_build_object('is_gf1', true)
    where not exists (
      select 1
      from public.matches mx
      where mx.tournament_id = p_tournament_id
        and mx.stage = 'PLAYOFF'
        and mx.bracket_type = 'LOSERS'
        and mx.round = v_gf1_round
        and mx.bracket_slot = 1
    );

    update public.matches
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('is_gf1', true)
    where tournament_id = p_tournament_id
      and stage = 'PLAYOFF'
      and bracket_type = 'LOSERS'
      and round = v_gf1_round
      and bracket_slot = 1;

    for v_round in 1..(v_lb_round_count - 1) loop
      for v_slot in 1..v_lb_matches[v_round] loop
        select id into v_mid
        from public.matches
        where tournament_id = p_tournament_id
          and stage='PLAYOFF' and bracket_type='LOSERS'
          and round=v_round and bracket_slot=v_slot;

        v_to_slot := ceil(v_slot / 2.0)::int;
        select id into v_parent
        from public.matches
        where tournament_id = p_tournament_id
          and stage='PLAYOFF' and bracket_type='LOSERS'
          and round=(v_round + 1)
          and bracket_slot=v_to_slot;

        v_parent_side := case when mod(v_slot, 2)=1 then 'HOME' else 'AWAY' end;

        update public.matches
        set next_match_id = v_parent,
            next_match_side = v_parent_side
        where id = v_mid;
      end loop;
    end loop;

    if array_length(v_drop_round_by_wb, 1) is not null then
      -- Recompute alive tree and tag drops by *actual winners bracket slot*.
      v_seed_positions := array[1, 2];
      while array_length(v_seed_positions, 1) < v_s loop
        v_next_positions := '{}'::int[];
        foreach v_pos in array v_seed_positions loop
          v_next_positions := array_append(v_next_positions, v_pos);
          v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
        end loop;
        v_seed_positions := v_next_positions;
      end loop;

      v_leaf_alive := '{}'::int[];
      for v_pos in 1..v_s loop
        if v_seed_positions[v_pos] <= v_n then
          v_leaf_alive := array_append(v_leaf_alive, 1);
        else
          v_leaf_alive := array_append(v_leaf_alive, 0);
        end if;
      end loop;

      for v_round in 1..v_rounds loop
        v_next_alive := '{}'::int[];
        v_from_slot := 0;

        for v_slot in 1..(array_length(v_leaf_alive, 1) / 2) loop
          v_child_a := v_leaf_alive[(v_slot * 2) - 1];
          v_child_b := v_leaf_alive[v_slot * 2];

          if v_child_a = 1 and v_child_b = 1 then
            v_from_slot := v_from_slot + 1;

            if array_length(v_drop_round_by_wb, 1) >= v_round then
              v_to_slot := case
                when v_round = 1 then ceil(v_from_slot / 2.0)::int
                else v_from_slot
              end;

              update public.matches
              set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                'wb_drop_round', v_round,
                'wb_drop_slot', v_slot
              )
              where tournament_id = p_tournament_id
                and stage = 'PLAYOFF'
                and bracket_type = 'LOSERS'
                and round = v_drop_round_by_wb[v_round]
                and bracket_slot = v_to_slot;
            end if;

            v_next_alive := array_append(v_next_alive, 1);
          elsif v_child_a = 1 or v_child_b = 1 then
            v_next_alive := array_append(v_next_alive, 1);
          else
            v_next_alive := array_append(v_next_alive, 0);
          end if;
        end loop;

        v_leaf_alive := v_next_alive;
      end loop;
    end if;

    if v_lb_round_count >= 1 then
      for v_slot in 1..v_lb_matches[v_lb_round_count] loop
        select id into v_mid
        from public.matches
        where tournament_id = p_tournament_id
          and stage='PLAYOFF' and bracket_type='LOSERS'
          and round=v_lb_round_count and bracket_slot=v_slot;

        select id into v_parent
        from public.matches
        where tournament_id = p_tournament_id
          and stage='PLAYOFF' and bracket_type='LOSERS'
          and round=v_gf1_round and bracket_slot=1;

        update public.matches
        set next_match_id = v_parent,
            next_match_side = 'AWAY'
        where id = v_mid;
      end loop;
    end if;

    -- Winners final winner goes to GF1 home.
    select id into v_parent
    from public.matches
    where tournament_id = p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
      and round=v_gf1_round and bracket_slot=1;

    update public.matches
    set next_match_id = v_parent,
        next_match_side = 'HOME'
    where tournament_id = p_tournament_id
      and stage='PLAYOFF' and bracket_type='WINNERS'
      and round=v_rounds and bracket_slot=1;
  else
    perform public.ensure_losers_bracket(p_tournament_id);
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

    if (select count(*) from public.tournament_playoff_seeds where tournament_id = p_tournament_id) <> v_n then
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
    and stage='PLAYOFF'
    and (
      (bracket_type='WINNERS' and round > 1)
      or bracket_type='LOSERS'
    );

  if v_is_full_with_losers and v_n >= 4 and v_n <= 16 then
    perform public.advance_playoff_byes(p_tournament_id);
  else
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
  end if;

  for r in
    select id from public.matches
    where tournament_id = p_tournament_id and stage='PLAYOFF'
  loop
    perform public.sync_match_identities_from_participants(r.id);
  end loop;
end;
