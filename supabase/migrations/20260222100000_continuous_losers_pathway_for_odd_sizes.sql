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
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'PLAYOFF' or m.bracket_type <> 'WINNERS' then
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

  if v_preset = 'full_with_losers' and v_max_round >= 3 then
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

    if target is not null then
      update public.matches
      set home_participant_id = v_home,
          away_participant_id = v_away
      where id = target;

      perform public.sync_match_identities_from_participants(target);
    end if;

    if m.round < v_max_round then
      v_parent_round := m.round + 1;
      v_parent_slot := ceil(v_group_slot / 2.0)::int;

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
            where id = v_parent_id;
          else
            update public.matches
            set away_participant_id = coalesce(away_participant_id, v_singleton)
            where id = v_parent_id;
          end if;
          perform public.sync_match_identities_from_participants(v_parent_id);
        end if;
      end if;
    end if;

    return new;
  end if;

  -- full_no_losers / playoffs_only: keep third-place placement fed only by semifinal losers.
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
    end if;
  end if;

  return new;
end;
$$;
