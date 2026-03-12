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
  v_final_id uuid;
  v_class_id uuid;
  v_target_home uuid;
  v_target_away uuid;
  v_final_home uuid;
  v_final_away uuid;
  v_class_home uuid;
  v_class_away uuid;
  v_semifinal_result record;
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
    -- 4-entrant full_with_losers has only the third-place game on LOSERS side;
    -- do not propagate winners/losers from that game into additional rounds.
    if v_max_round = 2 then
      return new;
    end if;

    if m.round <> v_semifinal_round then
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

    select id into v_final_id
    from public.matches
    where tournament_id = m.tournament_id
      and stage = 'PLAYOFF'
      and bracket_type = 'LOSERS'
      and round = m.round + 1
      and bracket_slot = 1;

    v_final_home := null;
    v_final_away := null;
    v_class_home := null;
    v_class_away := null;

    -- Rebuild final-stage placement participants from all resolved LOSERS semifinals
    -- so ordering of lock events and BYE semifinals cannot produce orphan BYE boxes.
    for v_semifinal_result in
      select
        lm.bracket_slot,
        case
          when lmr.home_score > lmr.away_score then lm.home_participant_id
          when lmr.away_score > lmr.home_score then lm.away_participant_id
          else null
        end as winner_id,
        case
          when lmr.home_score > lmr.away_score then lm.away_participant_id
          when lmr.away_score > lmr.home_score then lm.home_participant_id
          else null
        end as loser_id
      from public.matches lm
      join public.match_results lmr on lmr.match_id = lm.id and lmr.locked = true
      where lm.tournament_id = m.tournament_id
        and lm.stage = 'PLAYOFF'
        and lm.bracket_type = 'LOSERS'
        and lm.round = m.round
      order by lm.bracket_slot
    loop
      v_next_side := case when mod(coalesce(v_semifinal_result.bracket_slot, 1), 2) = 1 then 'HOME' else 'AWAY' end;

      if v_next_side = 'HOME' then
        v_final_home := coalesce(v_final_home, v_semifinal_result.winner_id);
        v_class_home := coalesce(v_class_home, v_semifinal_result.loser_id);
      else
        v_final_away := coalesce(v_final_away, v_semifinal_result.winner_id);
        v_class_away := coalesce(v_class_away, v_semifinal_result.loser_id);
      end if;
    end loop;

    if v_final_id is not null then
      update public.matches
      set home_participant_id = v_final_home,
          away_participant_id = v_final_away
      where id = v_final_id;

      perform public.sync_match_identities_from_participants(v_final_id);
      perform public.balance_match_home_away(v_final_id);
    end if;

    -- Create a secondary classification game only when both semifinal sides
    -- produced real losers (even-size behavior like 6 entrants).
    if v_class_home is not null and v_class_away is not null then
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

      if v_class_id is not null then
        update public.matches
        set home_participant_id = v_class_home,
            away_participant_id = v_class_away
        where id = v_class_id;

        perform public.sync_match_identities_from_participants(v_class_id);
        perform public.balance_match_home_away(v_class_id);
      end if;
    else
      delete from public.matches lm
      where lm.tournament_id = m.tournament_id
        and lm.stage = 'PLAYOFF'
        and lm.bracket_type = 'LOSERS'
        and lm.round = m.round + 1
        and lm.bracket_slot = 2
        and not exists (
          select 1
          from public.match_results mr
          where mr.match_id = lm.id
            and mr.locked = true
        );
    end if;

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
