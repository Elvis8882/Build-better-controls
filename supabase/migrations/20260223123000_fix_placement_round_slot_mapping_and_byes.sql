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
        end if;

        v_parent_round := m.round + 1;
        -- Keep same slot index into next placement round so odd first-round pathways
        -- can still populate multiple semifinal boxes instead of collapsing to slot 1.
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

        -- Once all losers from this winners round are known, auto-advance any singleton
        -- (odd participant count in this placement level) to the next round.
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
            end if;
          end loop;
        end if;
      else
        -- Semifinal losers should face prior placement advancers; fill closest TBD AWAY slot.
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

  if v_next_side = 'HOME' then
    update public.matches set home_participant_id = coalesce(home_participant_id, winner) where id = v_final_id;
    update public.matches set home_participant_id = coalesce(home_participant_id, loser) where id = v_class_id;
  else
    update public.matches set away_participant_id = coalesce(away_participant_id, winner) where id = v_final_id;
    update public.matches set away_participant_id = coalesce(away_participant_id, loser) where id = v_class_id;
  end if;

  perform public.sync_match_identities_from_participants(v_final_id);
  perform public.sync_match_identities_from_participants(v_class_id);

  return new;
end;
$$;
