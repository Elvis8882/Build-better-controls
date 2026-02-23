-- Deploy latest routine bodies for home/away balancing and placement routing fixes.

create or replace function public.generate_group_stage(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
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

create or replace function public.balance_match_home_away(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  v_has_group boolean;
  v_home_seed int;
  v_away_seed int;
  v_home_diff int;
  v_away_diff int;
  v_new_home uuid;
  v_new_away uuid;
begin
  select *
  into m
  from public.matches
  where id = p_match_id;

  if m.id is null or m.home_participant_id is null or m.away_participant_id is null then
    return;
  end if;

  v_new_home := m.home_participant_id;
  v_new_away := m.away_participant_id;

  select exists (
    select 1
    from public.tournament_groups tg
    where tg.tournament_id = m.tournament_id
  ) into v_has_group;

  if v_has_group then
    select seed into v_home_seed
    from public.v_playoff_seeds
    where tournament_id = m.tournament_id
      and participant_id = m.home_participant_id;

    select seed into v_away_seed
    from public.v_playoff_seeds
    where tournament_id = m.tournament_id
      and participant_id = m.away_participant_id;

    if v_home_seed is not null and v_away_seed is not null and v_away_seed < v_home_seed then
      v_new_home := m.away_participant_id;
      v_new_away := m.home_participant_id;
    end if;
  else
    select
      coalesce(sum(case when pm.home_participant_id = m.home_participant_id then 1 else 0 end), 0)
      - coalesce(sum(case when pm.away_participant_id = m.home_participant_id then 1 else 0 end), 0)
    into v_home_diff
    from public.matches pm
    where pm.tournament_id = m.tournament_id
      and pm.id <> m.id;

    select
      coalesce(sum(case when pm.home_participant_id = m.away_participant_id then 1 else 0 end), 0)
      - coalesce(sum(case when pm.away_participant_id = m.away_participant_id then 1 else 0 end), 0)
    into v_away_diff
    from public.matches pm
    where pm.tournament_id = m.tournament_id
      and pm.id <> m.id;

    if v_home_diff > v_away_diff then
      v_new_home := m.away_participant_id;
      v_new_away := m.home_participant_id;
    end if;
  end if;

  if v_new_home <> m.home_participant_id or v_new_away <> m.away_participant_id then
    update public.matches
    set home_participant_id = v_new_home,
        away_participant_id = v_new_away
    where id = m.id;

    perform public.sync_match_identities_from_participants(m.id);
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
  select preset_id into v_preset
  from public.tournaments
  where id = p_tournament_id;

  -- freeze if any playoff match is locked
  select exists (
    select 1
    from public.matches m
    join public.match_results mr on mr.match_id = m.id
    where m.tournament_id = p_tournament_id
      and m.stage = 'PLAYOFF'
      and mr.locked = true
  ) into v_any_playoff_locked;

  -- determine participants count
  select count(*) into v_n
  from public.tournament_participants
  where tournament_id = p_tournament_id;

  if v_n < 3 then
    return;
  end if;

  -- next power of two
  v_s := 1;
  while v_s < v_n loop v_s := v_s * 2; end loop;
  v_rounds := (log(v_s)::numeric / log(2)::numeric)::int;

  -- ensure bracket graph exists (matches for all rounds/slots)
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

  -- build next pointers (winner advances)
  -- parent match is in round+1 at ceil(slot/2)
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

  -- ensure placement shell can still appear for existing tournaments even when winners are frozen
  perform public.ensure_losers_bracket(p_tournament_id);

  -- If frozen, don't reseed/overwrite Round 1 assignments
  if v_any_playoff_locked then
    return;
  end if;

  -- detect if group stage exists (any groups/members)
  select exists (
    select 1
    from public.tournament_groups
    where tournament_id = p_tournament_id
  ) into v_has_group;

  if v_has_group then
    -- seed from standings (mixed across groups)
    select array_agg(participant_id order by seed asc) into v_seeded
    from public.v_playoff_seeds
    where tournament_id = p_tournament_id;
  else
    -- playoffs_only or no groups: ensure persisted random seeding
    if not exists (select 1 from public.tournament_playoff_seeds where tournament_id = p_tournament_id) then
      insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
      select p_tournament_id,
             row_number() over (order by random())::int as seed,
             id
      from public.tournament_participants
      where tournament_id = p_tournament_id;
    end if;

    -- heal stale or mismatched seed rows
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
      select p_tournament_id,
             row_number() over (order by random())::int as seed,
             id
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

  -- assign Round 1 using balanced bracket seed order so top seeds start in opposite branches
  -- e.g. S=8 => [1,8,4,5,2,7,3,6], yielding pairs (1v8),(4v5),(2v7),(3v6)
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

    -- sync identity columns
    select id into v_mid
    from public.matches
    where tournament_id = p_tournament_id
      and stage='PLAYOFF' and bracket_type='WINNERS'
      and round=1 and bracket_slot=v_slot;

    perform public.sync_match_identities_from_participants(v_mid);
    perform public.balance_match_home_away(v_mid);
  end loop;

  -- clear later round participant slots to allow fresh propagation (only if no playoff locks)
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

  -- propagate only first-round BYEs forward (single hop)
  -- avoids cascading auto-skips into later rounds before real games are played
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

  -- sync identities for all playoff matches (cheap, but OK at this scale)
  for r in
    select id from public.matches
    where tournament_id = p_tournament_id and stage='PLAYOFF' and bracket_type='WINNERS'
  loop
    perform public.sync_match_identities_from_participants(r.id);
  end loop;

  -- stage can be PLAYOFF even if group exists; leave to triggers/logic
end;
$$;

create or replace function public.trg_advance_playoff_winner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
  perform public.balance_match_home_away(m.next_match_id);

  return new;
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
  v_preset text;
  v_max_round int;
  v_semifinal_round int;
  loser uuid;
  winner uuid;
  target uuid;
  v_source_slot int;
  v_pair_slot int;
  v_parent_round int;
  v_parent_slot int;
  v_parent_id uuid;
  v_home uuid;
  v_away uuid;
  v_final_id uuid;
  v_class_id uuid;
  v_next_side text;
  v_actual_game_count int;
  v_entrant_count int;
  v_singleton_match record;
  v_singleton uuid;
  v_other_singleton uuid;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'PLAYOFF' then
    return new;
  end if;

  select preset_id into v_preset from public.tournaments where id = m.tournament_id;
  if v_preset is null then
    return new;
  end if;

  if m.bracket_type = 'WINNERS' then
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

    v_semifinal_round := greatest(v_max_round - 1, 1);
    if m.round < 1 or m.round > v_semifinal_round then
      return new;
    end if;

    v_source_slot := greatest(coalesce(m.bracket_slot, 1), 1);

    insert into public.playoff_placement_entrants(
      tournament_id,
      participant_id,
      source_match_id,
      source_round,
      source_slot,
      source_stage,
      source_group_slot
    )
    values (
      m.tournament_id,
      loser,
      m.id,
      m.round,
      v_source_slot,
      case when m.round = v_semifinal_round then 'SF' else 'QF' end,
      v_source_slot
    )
    on conflict (source_match_id) do update
    set participant_id = excluded.participant_id,
        source_round = excluded.source_round,
        source_slot = excluded.source_slot,
        source_stage = excluded.source_stage,
        source_group_slot = excluded.source_group_slot;

    if v_preset = 'full_with_losers' and v_max_round >= 3 then
      if m.round < v_semifinal_round then
        v_pair_slot := ceil(v_source_slot / 2.0)::int;

        insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
        select m.tournament_id, 'PLAYOFF', 'LOSERS', m.round, v_pair_slot
        where not exists (
          select 1 from public.matches mx
          where mx.tournament_id = m.tournament_id
            and mx.stage = 'PLAYOFF'
            and mx.bracket_type = 'LOSERS'
            and mx.round = m.round
            and mx.bracket_slot = v_pair_slot
        );

        select id into target
        from public.matches
        where tournament_id = m.tournament_id
          and stage = 'PLAYOFF'
          and bracket_type = 'LOSERS'
          and round = m.round
          and bracket_slot = v_pair_slot;

        select e.participant_id into v_home
        from public.playoff_placement_entrants e
        where e.tournament_id = m.tournament_id
          and e.source_round = m.round
          and ceil(e.source_slot / 2.0)::int = v_pair_slot
        order by e.source_slot asc, e.created_at asc, e.id asc
        limit 1;

        select e.participant_id into v_away
        from public.playoff_placement_entrants e
        where e.tournament_id = m.tournament_id
          and e.source_round = m.round
          and ceil(e.source_slot / 2.0)::int = v_pair_slot
        order by e.source_slot asc, e.created_at asc, e.id asc
        offset 1
        limit 1;

        if target is not null then
          update public.matches
          set home_participant_id = v_home,
              away_participant_id = v_away
          where id = target;
          perform public.sync_match_identities_from_participants(target);
          perform public.balance_match_home_away(target);
        end if;

        v_parent_round := m.round + 1;
        v_parent_slot := v_pair_slot;

        insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
        select m.tournament_id, 'PLAYOFF', 'LOSERS', v_parent_round, v_parent_slot
        where not exists (
          select 1 from public.matches mx
          where mx.tournament_id = m.tournament_id
            and mx.stage = 'PLAYOFF'
            and mx.bracket_type = 'LOSERS'
            and mx.round = v_parent_round
            and mx.bracket_slot = v_parent_slot
        );

        select id into v_parent_id
        from public.matches
        where tournament_id = m.tournament_id
          and stage = 'PLAYOFF'
          and bracket_type = 'LOSERS'
          and round = v_parent_round
          and bracket_slot = v_parent_slot;

        update public.matches
        set next_match_id = v_parent_id,
            next_match_side = 'HOME'
        where id = target;

        select count(*) into v_actual_game_count
        from public.matches wm
        where wm.tournament_id = m.tournament_id
          and wm.stage = 'PLAYOFF'
          and wm.bracket_type = 'WINNERS'
          and wm.round = m.round
          and wm.home_participant_id is not null
          and wm.away_participant_id is not null;

        select count(*) into v_entrant_count
        from public.playoff_placement_entrants e
        where e.tournament_id = m.tournament_id
          and e.source_round = m.round;

        if v_entrant_count >= 1 and v_entrant_count = v_actual_game_count then
          for v_singleton_match in
            select lm.id, lm.bracket_slot, lm.home_participant_id, lm.away_participant_id
            from public.matches lm
            where lm.tournament_id = m.tournament_id
              and lm.stage = 'PLAYOFF'
              and lm.bracket_type = 'LOSERS'
              and lm.round = m.round
          loop
            v_singleton := null;
            if v_singleton_match.home_participant_id is not null and v_singleton_match.away_participant_id is null then
              v_singleton := v_singleton_match.home_participant_id;
            elsif v_singleton_match.home_participant_id is null and v_singleton_match.away_participant_id is not null then
              v_singleton := v_singleton_match.away_participant_id;
            end if;

            if v_singleton is not null then
              v_parent_round := m.round + 1;
              v_parent_slot := v_singleton_match.bracket_slot;

              insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
              select m.tournament_id, 'PLAYOFF', 'LOSERS', v_parent_round, v_parent_slot
              where not exists (
                select 1 from public.matches mx
                where mx.tournament_id = m.tournament_id
                  and mx.stage = 'PLAYOFF'
                  and mx.bracket_type = 'LOSERS'
                  and mx.round = v_parent_round
                  and mx.bracket_slot = v_parent_slot
              );

              select id into v_parent_id
              from public.matches
              where tournament_id = m.tournament_id
                and stage = 'PLAYOFF'
                and bracket_type = 'LOSERS'
                and round = v_parent_round
                and bracket_slot = v_parent_slot;

              update public.matches
              set next_match_id = v_parent_id,
                  next_match_side = 'HOME'
              where id = v_singleton_match.id;

              update public.matches
              set home_participant_id = coalesce(home_participant_id, v_singleton)
              where id = v_parent_id;

              perform public.sync_match_identities_from_participants(v_parent_id);
              perform public.balance_match_home_away(v_parent_id);
            end if;
          end loop;
        end if;
      else
        select id into target
        from public.matches lm
        where lm.tournament_id = m.tournament_id
          and lm.stage = 'PLAYOFF'
          and lm.bracket_type = 'LOSERS'
          and lm.round = m.round
          and lm.away_participant_id is null
        order by (case when lm.home_participant_id is null then 1 else 0 end), lm.bracket_slot asc, lm.created_at asc
        limit 1;

        if target is null then
          insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
          values (m.tournament_id, 'PLAYOFF', 'LOSERS', m.round, v_source_slot)
          on conflict do nothing;

          select id into target
          from public.matches
          where tournament_id = m.tournament_id
            and stage = 'PLAYOFF'
            and bracket_type = 'LOSERS'
            and round = m.round
            and bracket_slot = v_source_slot;
        end if;

        if target is not null then
          update public.matches
          set away_participant_id = coalesce(away_participant_id, loser)
          where id = target;
          perform public.sync_match_identities_from_participants(target);
          perform public.balance_match_home_away(target);
        end if;
      end if;

      return new;
    end if;

    perform public.ensure_losers_bracket(m.tournament_id);

    if m.round = v_semifinal_round then
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
            away_participant_id = case when home_participant_id is not null and away_participant_id is null then loser else away_participant_id end
        where id = target;

        perform public.sync_match_identities_from_participants(target);
        perform public.balance_match_home_away(target);
      end if;
    end if;

    return new;
  end if;

  if m.bracket_type <> 'LOSERS' or v_preset <> 'full_with_losers' then
    return new;
  end if;

  select coalesce(max(round), 1) into v_max_round
  from public.matches
  where tournament_id = m.tournament_id
    and stage = 'PLAYOFF'
    and bracket_type = 'WINNERS';

  v_semifinal_round := greatest(v_max_round - 1, 1);
  if m.round <> v_semifinal_round then
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

  if winner is null or loser is null then
    return new;
  end if;

  -- Ensure 3rd/4th final always exists.
  insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
  select m.tournament_id, 'PLAYOFF', 'LOSERS', m.round + 1, 1
  where not exists (
    select 1 from public.matches mx
    where mx.tournament_id = m.tournament_id
      and mx.stage = 'PLAYOFF'
      and mx.bracket_type = 'LOSERS'
      and mx.round = m.round + 1
      and mx.bracket_slot = 1
  );

  select id into v_final_id
  from public.matches
  where tournament_id = m.tournament_id
    and stage = 'PLAYOFF'
    and bracket_type = 'LOSERS'
    and round = m.round + 1
    and bracket_slot = 1;

  -- If semifinal round has a singleton participant in another box, this is a 3-participant semifinal:
  -- pair winner of the played semifinal with that singleton directly in final box 1.
  select coalesce(home_participant_id, away_participant_id) into v_other_singleton
  from public.matches sm
  where sm.tournament_id = m.tournament_id
    and sm.stage = 'PLAYOFF'
    and sm.bracket_type = 'LOSERS'
    and sm.round = m.round
    and sm.id <> m.id
    and ((sm.home_participant_id is not null and sm.away_participant_id is null)
      or (sm.home_participant_id is null and sm.away_participant_id is not null))
  order by sm.bracket_slot asc
  limit 1;

  if v_other_singleton is not null then
    -- Put semifinal match winner and singleton into the same final match.
    update public.matches
    set home_participant_id = coalesce(home_participant_id, winner),
        away_participant_id = case when coalesce(home_participant_id, winner) is not null then coalesce(away_participant_id, v_other_singleton) else away_participant_id end
    where id = v_final_id;

    perform public.sync_match_identities_from_participants(v_final_id);
    perform public.balance_match_home_away(v_final_id);
    return new;
  end if;

  -- Full semifinal boxes path (e.g. 6-participant case): two semis -> winners final + losers classification.
  insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
  select m.tournament_id, 'PLAYOFF', 'LOSERS', m.round + 1, 2
  where not exists (
    select 1 from public.matches mx
    where mx.tournament_id = m.tournament_id
      and mx.stage = 'PLAYOFF'
      and mx.bracket_type = 'LOSERS'
      and mx.round = m.round + 1
      and mx.bracket_slot = 2
  );

  select id into v_class_id
  from public.matches
  where tournament_id = m.tournament_id
    and stage = 'PLAYOFF'
    and bracket_type = 'LOSERS'
    and round = m.round + 1
    and bracket_slot = 2;

  v_next_side := case when mod(coalesce(m.bracket_slot, 1), 2) = 1 then 'HOME' else 'AWAY' end;

  if v_next_side = 'HOME' then
    update public.matches set home_participant_id = coalesce(home_participant_id, loser) where id = v_final_id;
    update public.matches set home_participant_id = coalesce(home_participant_id, winner) where id = v_class_id;
  else
    update public.matches set away_participant_id = coalesce(away_participant_id, loser) where id = v_final_id;
    update public.matches set away_participant_id = coalesce(away_participant_id, winner) where id = v_class_id;
  end if;

  perform public.sync_match_identities_from_participants(v_final_id);
  perform public.sync_match_identities_from_participants(v_class_id);
  perform public.balance_match_home_away(v_final_id);
  perform public.balance_match_home_away(v_class_id);

  return new;
end;
$$;
