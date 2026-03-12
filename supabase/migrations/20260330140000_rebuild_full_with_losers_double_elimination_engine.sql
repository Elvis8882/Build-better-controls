create or replace function public.advance_playoff_byes(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed boolean := true;
  r record;
  v_advancer uuid;
begin
  while v_changed loop
    v_changed := false;

    for r in
      select id, home_participant_id, away_participant_id, next_match_id, next_match_side
      from public.matches
      where tournament_id = p_tournament_id
        and stage = 'PLAYOFF'
      order by case bracket_type when 'WINNERS' then 1 else 2 end, round asc, bracket_slot asc
    loop
      if r.next_match_id is null or r.next_match_side is null then
        continue;
      end if;

      v_advancer := null;
      if r.home_participant_id is not null and r.away_participant_id is null then
        v_advancer := r.home_participant_id;
      elsif r.away_participant_id is not null and r.home_participant_id is null then
        v_advancer := r.away_participant_id;
      end if;

      if v_advancer is null then
        continue;
      end if;

      if r.next_match_side = 'HOME' then
        update public.matches
        set home_participant_id = coalesce(home_participant_id, v_advancer)
        where id = r.next_match_id
          and away_participant_id is distinct from v_advancer;
      else
        update public.matches
        set away_participant_id = coalesce(away_participant_id, v_advancer)
        where id = r.next_match_id
          and home_participant_id is distinct from v_advancer;
      end if;

      if found then
        perform public.sync_match_identities_from_participants(r.next_match_id);
        perform public.balance_match_home_away(r.next_match_id);
        v_changed := true;
      end if;
    end loop;
  end loop;
end;
$$;

grant execute on function public.advance_playoff_byes(uuid) to authenticated;

create or replace function public.ensure_playoff_bracket(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
  v_drop_round int;
  v_loser_rounds int;
  v_is_full_with_losers boolean := false;
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

  -- Generalized double-elimination graph for full_with_losers presets.
  if v_is_full_with_losers and v_n >= 4 and v_n <= 16 then
    delete from public.playoff_placement_entrants where tournament_id = p_tournament_id;
    delete from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS';

    for v_round in 1..v_rounds loop
      v_matches_in_round := v_s / (2^v_round);
      for v_slot in 1..v_matches_in_round loop
        insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
        values (p_tournament_id, 'PLAYOFF', 'WINNERS', v_round, v_slot)
        on conflict (tournament_id, stage, bracket_type, round, bracket_slot) do nothing;
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

    -- Losers bracket: L1 + alternating drop/consolidation rounds + GF1/GF2.
    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
    values (p_tournament_id, 'PLAYOFF', 'LOSERS', 1, 1)
    on conflict (tournament_id, stage, bracket_type, round, bracket_slot) do nothing;

    for v_round in 1..(v_rounds-1) loop
      -- Drop round fed by losers from winners round (v_round + 1)
      v_drop_round := (v_round * 2);
      v_matches_in_round := v_s / (2^(v_round + 1));
      for v_slot in 1..v_matches_in_round loop
        insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
        values (p_tournament_id, 'PLAYOFF', 'LOSERS', v_drop_round, v_slot)
        on conflict (tournament_id, stage, bracket_type, round, bracket_slot) do nothing;
      end loop;

      -- Consolidation round (not needed before GF drop)
      if v_round < (v_rounds - 1) then
        v_matches_in_round := v_s / (2^(v_round + 2));
        for v_slot in 1..v_matches_in_round loop
          insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
          values (p_tournament_id, 'PLAYOFF', 'LOSERS', v_drop_round + 1, v_slot)
          on conflict (tournament_id, stage, bracket_type, round, bracket_slot) do nothing;
        end loop;
      end if;
    end loop;

    v_loser_rounds := (v_rounds - 1) * 2;
    -- GF1 and GF reset as LOSERS rounds after LB final.
    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
    values (p_tournament_id, 'PLAYOFF', 'LOSERS', v_loser_rounds + 1, 1)
    on conflict (tournament_id, stage, bracket_type, round, bracket_slot) do nothing;

    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
    values (p_tournament_id, 'PLAYOFF', 'LOSERS', v_loser_rounds + 2, 1)
    on conflict (tournament_id, stage, bracket_type, round, bracket_slot) do nothing;

    -- Wire LOSERS winner progression.
    for v_round in 1..v_loser_rounds loop
      v_matches_in_round := greatest(v_s / (2^(ceil((v_round + 2) / 2.0)::int + 1)), 1);
      for v_slot in 1..v_matches_in_round loop
        select id into v_mid
        from public.matches
        where tournament_id = p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
          and round=v_round and bracket_slot=v_slot;

        if mod(v_round, 2) = 1 then
          select id into v_parent
          from public.matches
          where tournament_id = p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
            and round=v_round + 1 and bracket_slot=v_slot;
          v_parent_side := 'HOME';
        else
          if v_round = v_loser_rounds then
            select id into v_parent
            from public.matches
            where tournament_id = p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
              and round=v_loser_rounds + 1 and bracket_slot=1;
            v_parent_side := 'AWAY';
          else
            select id into v_parent
            from public.matches
            where tournament_id = p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
              and round=v_round + 1 and bracket_slot=ceil(v_slot / 2.0)::int;
            v_parent_side := case when mod(v_slot, 2)=1 then 'HOME' else 'AWAY' end;
          end if;
        end if;

        update public.matches
        set next_match_id = v_parent,
            next_match_side = v_parent_side
        where id = v_mid;
      end loop;
    end loop;

    -- Winners final winner goes to GF1 home.
    select id into v_parent
    from public.matches
    where tournament_id = p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
      and round=v_loser_rounds + 1 and bracket_slot=1;

    update public.matches
    set next_match_id = v_parent,
        next_match_side = 'HOME'
    where tournament_id = p_tournament_id
      and stage='PLAYOFF' and bracket_type='WINNERS'
      and round=v_rounds and bracket_slot=1;
  else
    perform public.ensure_losers_bracket(p_tournament_id);
  end if;

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
  winner uuid;
  target uuid;
  v_preset text;
  v_max_round int;
  v_drop_round int;
  v_target_slot int;
  v_target_side text;
  v_gf1_round int;
  v_gf2_id uuid;
  v_is_full_with_losers boolean := false;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'PLAYOFF' then
    return new;
  end if;

  select preset_id, public.preset_is_full_with_losers(preset_id)
  into v_preset, v_is_full_with_losers
  from public.tournaments
  where id = m.tournament_id;

  if m.bracket_type = 'LOSERS' then
    if not v_is_full_with_losers then
      return new;
    end if;

    if new.home_score > new.away_score then
      winner := m.home_participant_id;
      loser := m.away_participant_id;
    elsif new.away_score > new.home_score then
      winner := m.away_participant_id;
      loser := m.home_participant_id;
    else
      return new;
    end if;

    if winner is null then
      return new;
    end if;

    -- Grand Final reset support: GF1 is the first LOSERS round after LB rounds.
    select coalesce(max(round), 1) into v_max_round
    from public.matches
    where tournament_id = m.tournament_id
      and stage = 'PLAYOFF'
      and bracket_type = 'WINNERS';

    v_gf1_round := ((v_max_round - 1) * 2) + 1;

    if m.round = v_gf1_round then
      -- If LB side wins GF1, both finalists now have one loss -> activate GF2.
      if winner = m.away_participant_id and loser is not null then
        select id into v_gf2_id
        from public.matches
        where tournament_id = m.tournament_id
          and stage = 'PLAYOFF'
          and bracket_type = 'LOSERS'
          and round = v_gf1_round + 1
          and bracket_slot = 1;

        if v_gf2_id is not null then
          update public.matches
          set home_participant_id = m.home_participant_id,
              away_participant_id = m.away_participant_id
          where id = v_gf2_id;

          perform public.sync_match_identities_from_participants(v_gf2_id);
          perform public.balance_match_home_away(v_gf2_id);
        end if;
      end if;
    end if;

    perform public.advance_playoff_byes(m.tournament_id);
    return new;
  end if;

  if m.bracket_type <> 'WINNERS' then
    return new;
  end if;

  if m.home_participant_id is null or m.away_participant_id is null then
    return new;
  end if;

  if new.home_score > new.away_score then
    loser := m.away_participant_id;
  elsif new.away_score > new.home_score then
    loser := m.home_participant_id;
  else
    return new;
  end if;

  if loser is null then
    return new;
  end if;

  select coalesce(max(round), 1) into v_max_round
  from public.matches
  where tournament_id = m.tournament_id
    and stage = 'PLAYOFF'
    and bracket_type = 'WINNERS';

  if v_is_full_with_losers and v_max_round >= 2 then
    if m.round = 1 then
      v_drop_round := 1;
      v_target_slot := ceil(greatest(coalesce(m.bracket_slot, 1), 1) / 2.0)::int;
    else
      v_drop_round := (m.round - 1) * 2;
      v_target_slot := greatest(coalesce(m.bracket_slot, 1), 1);
    end if;

    v_target_side := case when mod(greatest(coalesce(m.bracket_slot, 1), 1), 2) = 1 then 'HOME' else 'AWAY' end;

    select id into target
    from public.matches
    where tournament_id = m.tournament_id
      and stage = 'PLAYOFF'
      and bracket_type = 'LOSERS'
      and round = v_drop_round
      and bracket_slot = v_target_slot;

    if target is not null then
      if v_target_side = 'HOME' then
        update public.matches
        set home_participant_id = coalesce(home_participant_id, loser)
        where id = target
          and away_participant_id is distinct from loser;
      else
        update public.matches
        set away_participant_id = coalesce(away_participant_id, loser)
        where id = target
          and home_participant_id is distinct from loser;
      end if;

      perform public.sync_match_identities_from_participants(target);
      perform public.balance_match_home_away(target);
    end if;

    perform public.advance_playoff_byes(m.tournament_id);
    return new;
  end if;

  -- Legacy/non-full-with-losers behavior: keep third-place feeder.
  if public.preset_is_playoff_only(v_preset)
     or not public.preset_is_full_with_losers(v_preset) then
    perform public.ensure_losers_bracket(m.tournament_id);

    if m.round = greatest(v_max_round - 1, 1) then
      select id into target
      from public.matches
      where tournament_id = m.tournament_id
        and stage = 'PLAYOFF'
        and bracket_type = 'LOSERS'
        and round = 1
        and bracket_slot = 1;

      if target is not null then
        update public.matches
        set home_participant_id = coalesce(home_participant_id, loser),
            away_participant_id = case
              when coalesce(home_participant_id, loser) is not null
               and away_participant_id is null
               and coalesce(home_participant_id, loser) is distinct from loser
              then loser
              else away_participant_id
            end
        where id = target;

        perform public.sync_match_identities_from_participants(target);
        perform public.balance_match_home_away(target);
      end if;
    end if;
  end if;

  return new;
end;
$$;
