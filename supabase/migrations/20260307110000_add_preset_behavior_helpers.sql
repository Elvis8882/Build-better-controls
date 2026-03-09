create or replace function public.preset_is_full_with_losers(p_preset text)
returns boolean
language plpgsql
immutable
as $$
begin
  return p_preset = 'full_with_losers';
end;
$$;

create or replace function public.preset_is_playoff_only(p_preset text)
returns boolean
language plpgsql
immutable
as $$
begin
  return p_preset in ('playoffs_only', '2v2_playoffs');
end;
$$;

create or replace function public.preset_is_team_based(p_preset text)
returns boolean
language plpgsql
immutable
as $$
begin
  return p_preset in ('2v2_tournament', '2v2_playoffs');
end;
$$;

create or replace function public.ensure_losers_bracket(p_tournament_id uuid)
returns void
language plpgsql
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

  -- For playoff-only flows (playoffs_only / 2v2_playoffs) and no-losers full flows
  -- (full_no_losers / 2v2_tournament), keep only a dedicated 3rd-place shell.
  if public.preset_is_playoff_only(v_preset)
     or not public.preset_is_full_with_losers(v_preset) then
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
  end if;
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
  select preset_id, public.preset_is_team_based(preset_id)
  into v_preset, v_team_based
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

  -- determine entrant count (team-based for 2v2 flows: 2v2_tournament / 2v2_playoffs)
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

create or replace function public.trg_place_losers_into_losers_bracket()
returns trigger
language plpgsql
as $$
declare
  m record;
  loser uuid;
  winner uuid;
  target uuid;
  v_preset text;
  v_max_round int;
  v_semifinal_round int;
  v_source_stage text;
  v_group_slot int;
  v_parent_round int;
  v_parent_slot int;
  v_parent_id uuid;
  v_next_side text;
  v_home uuid;
  v_away uuid;
  v_singleton uuid;
  v_pair_slot int;
  v_pair_home uuid;
  v_pair_away uuid;
  v_round_locked_count int;
  v_candidate_count int;
  v_bye uuid;
  v_p1 uuid;
  v_p2 uuid;
  v_final_id uuid;
  v_class_id uuid;
  v_target_home uuid;
  v_target_away uuid;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'PLAYOFF' then
    return new;
  end if;

  if m.bracket_type = 'LOSERS' then
    select preset_id into v_preset from public.tournaments where id = m.tournament_id;
    if not public.preset_is_full_with_losers(v_preset) then
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

    select id into v_final_id
    from public.matches
    where tournament_id = m.tournament_id
      and stage = 'PLAYOFF'
      and bracket_type = 'LOSERS'
      and round = m.round + 1
      and bracket_slot = 1;

    select id into v_class_id
    from public.matches
    where tournament_id = m.tournament_id
      and stage = 'PLAYOFF'
      and bracket_type = 'LOSERS'
      and round = m.round + 1
      and bracket_slot = 2;

    v_next_side := case when mod(coalesce(m.bracket_slot, 1), 2) = 1 then 'HOME' else 'AWAY' end;

    -- Slot 1 is the higher-placement game (3rd/4th). Winners must flow there.
    if v_next_side = 'HOME' then
      update public.matches set home_participant_id = coalesce(home_participant_id, winner) where id = v_final_id;
      update public.matches set home_participant_id = coalesce(home_participant_id, loser) where id = v_class_id;
    else
      update public.matches set away_participant_id = coalesce(away_participant_id, winner) where id = v_final_id;
      update public.matches set away_participant_id = coalesce(away_participant_id, loser) where id = v_class_id;
    end if;

    perform public.sync_match_identities_from_participants(v_final_id);
    perform public.balance_match_home_away(v_final_id);
    perform public.sync_match_identities_from_participants(v_class_id);
    perform public.balance_match_home_away(v_class_id);

    return new;
  end if;

  if m.bracket_type <> 'WINNERS' then
    return new;
  end if;

  -- Actual-loser-only rule: BYE/auto-advance winners matches never emit placement entrants.
  if m.home_participant_id is null or m.away_participant_id is null then
    return new;
  end if;

  select preset_id into v_preset from public.tournaments where id = m.tournament_id;
  if v_preset is null then
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

  if m.round = v_semifinal_round then
    v_source_stage := 'SF';
    v_group_slot := greatest(coalesce(m.bracket_slot, 1), 1);
  else
    v_source_stage := 'QF';
    v_group_slot := ceil(greatest(coalesce(m.bracket_slot, 1), 1) / 2.0)::int;
  end if;

  if public.preset_is_full_with_losers(v_preset)
     and v_max_round = 2
     and m.round = v_semifinal_round then
    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
    select m.tournament_id, 'PLAYOFF', 'LOSERS', 1, 1
    where not exists (
      select 1 from public.matches mx
      where mx.tournament_id = m.tournament_id
        and mx.stage = 'PLAYOFF'
        and mx.bracket_type = 'LOSERS'
        and mx.round = 1
        and mx.bracket_slot = 1
    );

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

    return new;
  end if;

  -- Idempotent ingestion keyed by winners source match.
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
    greatest(coalesce(m.bracket_slot, 1), 1),
    v_source_stage,
    v_group_slot
  )
  on conflict (source_match_id) do update
  set participant_id = excluded.participant_id,
      source_round = excluded.source_round,
      source_slot = excluded.source_slot,
      source_stage = excluded.source_stage,
      source_group_slot = excluded.source_group_slot;

  if public.preset_is_full_with_losers(v_preset)
     and v_max_round = 2
     and m.round = v_semifinal_round then
    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
    select m.tournament_id, 'PLAYOFF', 'LOSERS', 1, 1
    where not exists (
      select 1 from public.matches mx
      where mx.tournament_id = m.tournament_id
        and mx.stage = 'PLAYOFF'
        and mx.bracket_type = 'LOSERS'
        and mx.round = 1
        and mx.bracket_slot = 1
    );

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

    return new;
  end if;

  if public.preset_is_full_with_losers(v_preset) and v_max_round >= 3 then
    -- Build placement levels from actual winners-loser buckets by source round/slot group.
    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
    select m.tournament_id, 'PLAYOFF', 'LOSERS', m.round, v_group_slot
    where not exists (
      select 1 from public.matches mx
      where mx.tournament_id = m.tournament_id
        and mx.stage = 'PLAYOFF'
        and mx.bracket_type = 'LOSERS'
        and mx.round = m.round
        and mx.bracket_slot = v_group_slot
    );

    select id into target
    from public.matches
    where tournament_id = m.tournament_id
      and stage = 'PLAYOFF'
      and bracket_type = 'LOSERS'
      and round = m.round
      and bracket_slot = v_group_slot;

    select e.participant_id into v_home
    from public.playoff_placement_entrants e
    where e.tournament_id = m.tournament_id
      and e.source_round = m.round
      and e.source_group_slot = v_group_slot
    order by e.source_slot asc, e.created_at asc, e.id asc
    limit 1;

    select e.participant_id into v_away
    from public.playoff_placement_entrants e
    where e.tournament_id = m.tournament_id
      and e.source_round = m.round
      and e.source_group_slot = v_group_slot
    order by e.source_slot asc, e.created_at asc, e.id asc
    offset 1
    limit 1;

    if v_home is not null and v_home = v_away then
      v_away := null;
    end if;

    if target is not null then
      if v_source_stage = 'SF' then
        select home_participant_id, away_participant_id
        into v_target_home, v_target_away
        from public.matches
        where id = target;

        if v_home is not null
          and v_home is distinct from v_target_home
          and v_home is distinct from v_target_away then
          if v_target_home is null then
            v_target_home := v_home;
          elsif v_target_away is null then
            v_target_away := v_home;
          end if;
        end if;

        update public.matches
        set home_participant_id = v_target_home,
            away_participant_id = v_target_away
        where id = target;
      else
        update public.matches
        set home_participant_id = v_home,
            away_participant_id = v_away
        where id = target;
      end if;

      perform public.sync_match_identities_from_participants(target);
      perform public.balance_match_home_away(target);
    end if;

    if m.round < v_semifinal_round then
      v_parent_round := m.round + 1;
      v_parent_slot := v_group_slot;

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

      v_next_side := case when mod(v_group_slot, 2) = 1 then 'HOME' else 'AWAY' end;

      update public.matches
      set next_match_id = v_parent_id,
          next_match_side = v_next_side
      where id = target;

      -- Odd-size fix: if round-1 has a real loser but its paired winners match is a BYE,
      -- carry that singleton into the next placement level as a waiting side.
      if m.round = 1 then
        v_singleton := coalesce(v_home, v_away);
        v_pair_slot := case when mod(greatest(coalesce(m.bracket_slot, 1), 1), 2) = 1
                        then greatest(coalesce(m.bracket_slot, 1), 1) + 1
                        else greatest(coalesce(m.bracket_slot, 1), 1) - 1
                      end;

        select home_participant_id, away_participant_id
        into v_pair_home, v_pair_away
        from public.matches
        where tournament_id = m.tournament_id
          and stage = 'PLAYOFF'
          and bracket_type = 'WINNERS'
          and round = 1
          and bracket_slot = v_pair_slot;

        if v_singleton is not null and (v_pair_home is null or v_pair_away is null) and v_parent_id is not null then
          if v_next_side = 'HOME' then
            update public.matches
            set home_participant_id = coalesce(home_participant_id, v_singleton)
            where id = v_parent_id
              and (away_participant_id is distinct from v_singleton or home_participant_id is not null);
          else
            update public.matches
            set away_participant_id = coalesce(away_participant_id, v_singleton)
            where id = v_parent_id
              and (home_participant_id is distinct from v_singleton or away_participant_id is not null);
          end if;
          perform public.sync_match_identities_from_participants(v_parent_id);
          perform public.balance_match_home_away(v_parent_id);
        end if;
      end if;

      -- When odd counts create exactly 3 contenders at the semifinal-placement level,
      -- keep the bracket playable by giving the best goals-for:goals-against contender
      -- a bye to the next round and pairing the remaining two in a single match.
      if m.round = v_semifinal_round then
        select count(*) into v_round_locked_count
        from public.matches lm
        join public.match_results lr on lr.match_id = lm.id
        where lm.tournament_id = m.tournament_id
          and lm.stage = 'PLAYOFF'
          and lm.bracket_type = 'LOSERS'
          and lm.round = m.round
          and lr.locked = true;

        if v_round_locked_count = 0 then
          select count(*) into v_candidate_count
          from (
            select distinct pid
            from (
              select lm.home_participant_id as pid
              from public.matches lm
              where lm.tournament_id = m.tournament_id
                and lm.stage = 'PLAYOFF'
                and lm.bracket_type = 'LOSERS'
                and lm.round = m.round
              union all
              select lm.away_participant_id as pid
              from public.matches lm
              where lm.tournament_id = m.tournament_id
                and lm.stage = 'PLAYOFF'
                and lm.bracket_type = 'LOSERS'
                and lm.round = m.round
              union all
              select e.participant_id as pid
              from public.playoff_placement_entrants e
              where e.tournament_id = m.tournament_id
                and e.source_round = m.round
            ) src
            where pid is not null
          ) ranked;

          if v_candidate_count = 3 then
            with ranked as (
              select
                p.pid,
                coalesce(sum(case
                  when pm.home_participant_id = p.pid then coalesce(pr.home_score, 0) - coalesce(pr.away_score, 0)
                  when pm.away_participant_id = p.pid then coalesce(pr.away_score, 0) - coalesce(pr.home_score, 0)
                  else 0
                end), 0)::int as goal_diff,
                coalesce(sum(case
                  when pm.home_participant_id = p.pid then coalesce(pr.home_shots, 0) - coalesce(pr.away_shots, 0)
                  when pm.away_participant_id = p.pid then coalesce(pr.away_shots, 0) - coalesce(pr.home_shots, 0)
                  else 0
                end), 0)::int as shots_diff,
                row_number() over (
                  order by
                    coalesce(sum(case
                      when pm.home_participant_id = p.pid then coalesce(pr.home_score, 0) - coalesce(pr.away_score, 0)
                      when pm.away_participant_id = p.pid then coalesce(pr.away_score, 0) - coalesce(pr.home_score, 0)
                      else 0
                    end), 0) desc,
                    coalesce(sum(case
                      when pm.home_participant_id = p.pid then coalesce(pr.home_shots, 0) - coalesce(pr.away_shots, 0)
                      when pm.away_participant_id = p.pid then coalesce(pr.away_shots, 0) - coalesce(pr.home_shots, 0)
                      else 0
                    end), 0) desc,
                    p.pid asc
                ) as rn
              from (
                select distinct pid
                from (
                  select lm.home_participant_id as pid
                  from public.matches lm
                  where lm.tournament_id = m.tournament_id
                    and lm.stage = 'PLAYOFF'
                    and lm.bracket_type = 'LOSERS'
                    and lm.round = m.round
                  union all
                  select lm.away_participant_id as pid
                  from public.matches lm
                  where lm.tournament_id = m.tournament_id
                    and lm.stage = 'PLAYOFF'
                    and lm.bracket_type = 'LOSERS'
                    and lm.round = m.round
                  union all
                  select e.participant_id as pid
                  from public.playoff_placement_entrants e
                  where e.tournament_id = m.tournament_id
                    and e.source_round = m.round
                ) src
                where pid is not null
              ) p
              left join public.matches pm
                on pm.tournament_id = m.tournament_id
               and pm.stage = 'PLAYOFF'
               and (pm.home_participant_id = p.pid or pm.away_participant_id = p.pid)
              left join public.match_results pr
                on pr.match_id = pm.id
               and pr.locked = true
              group by p.pid
            )
            select
              (array_agg(pid order by rn) filter (where rn = 1))[1],
              (array_agg(pid order by rn) filter (where rn = 2))[1],
              (array_agg(pid order by rn) filter (where rn = 3))[1]
            into v_bye, v_p1, v_p2
            from ranked;

            if v_p1 is not null and v_p1 = v_p2 then
              v_p2 := null;
            end if;

            if v_bye is not null and (v_bye = v_p1 or v_bye = v_p2) then
              v_bye := null;
            end if;

            select id into target
            from public.matches
            where tournament_id = m.tournament_id
              and stage = 'PLAYOFF'
              and bracket_type = 'LOSERS'
              and round = m.round
              and bracket_slot = 1;

            if target is null then
              insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
              values (m.tournament_id, 'PLAYOFF', 'LOSERS', m.round, 1)
              returning id into target;
            end if;

            select id into v_parent_id
            from public.matches
            where tournament_id = m.tournament_id
              and stage = 'PLAYOFF'
              and bracket_type = 'LOSERS'
              and round = (m.round + 1)
              and bracket_slot = 1;

            if v_parent_id is null then
              insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
              values (m.tournament_id, 'PLAYOFF', 'LOSERS', m.round + 1, 1)
              returning id into v_parent_id;
            end if;

            update public.matches
            set home_participant_id = v_p1,
                away_participant_id = v_p2,
                next_match_id = v_parent_id,
                next_match_side = 'AWAY'
            where id = target;

            update public.matches
            set home_participant_id = null,
                away_participant_id = null,
                next_match_id = null,
                next_match_side = null
            where tournament_id = m.tournament_id
              and stage = 'PLAYOFF'
              and bracket_type = 'LOSERS'
              and round = m.round
              and bracket_slot > 1;

            update public.matches
            set home_participant_id = coalesce(home_participant_id, v_bye)
            where id = v_parent_id
              and (away_participant_id is distinct from v_bye or home_participant_id is not null);

            perform public.sync_match_identities_from_participants(target);
            perform public.balance_match_home_away(target);
            perform public.sync_match_identities_from_participants(v_parent_id);
            perform public.balance_match_home_away(v_parent_id);
          end if;
        end if;
      end if;
    end if;

    return new;
  end if;

  -- No-losers and playoff-only flows (full_no_losers / 2v2_tournament / playoffs_only / 2v2_playoffs):
  -- keep third-place placement fed only by semifinal losers.
  if public.preset_is_playoff_only(v_preset)
     or not public.preset_is_full_with_losers(v_preset) then
    perform public.ensure_losers_bracket(m.tournament_id);
  end if;

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

  return new;
end;
$$;
