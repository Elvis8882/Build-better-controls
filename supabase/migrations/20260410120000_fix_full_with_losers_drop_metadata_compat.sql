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
  v_target_side text;
  v_gf2_id uuid;
  v_wb_drop_slot int;
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

    if coalesce((m.metadata->>'is_gf1')::boolean, false) then
      if winner = m.away_participant_id and loser is not null then
        select id into v_gf2_id
        from public.matches
        where tournament_id = m.tournament_id
          and stage = 'PLAYOFF'
          and bracket_type = 'LOSERS'
          and round = m.round + 1
          and bracket_slot = 1
          and coalesce((metadata->>'is_gf2')::boolean, false) = true;

        if v_gf2_id is null then
          insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot, metadata)
          values (m.tournament_id, 'PLAYOFF', 'LOSERS', m.round + 1, 1, jsonb_build_object('is_gf2', true))
          returning id into v_gf2_id;
        end if;

        if v_gf2_id is null then
          select id into v_gf2_id
          from public.matches
          where tournament_id = m.tournament_id
            and stage = 'PLAYOFF'
            and bracket_type = 'LOSERS'
            and round = m.round + 1
            and bracket_slot = 1
          limit 1;
        end if;

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
    v_target_side := case when mod(greatest(coalesce(m.bracket_slot, 1), 1), 2) = 1 then 'HOME' else 'AWAY' end;

    -- Preferred mapping: side-specific drop metadata introduced by the generalized
    -- full_with_losers generator.
    if v_target_side = 'HOME' then
      select id into target
      from public.matches
      where tournament_id = m.tournament_id
        and stage = 'PLAYOFF'
        and bracket_type = 'LOSERS'
        and ((metadata->>'wb_drop_home_round')::int) = m.round
        and ((metadata->>'wb_drop_home_slot')::int) = greatest(coalesce(m.bracket_slot, 1), 1)
      limit 1;
    else
      select id into target
      from public.matches
      where tournament_id = m.tournament_id
        and stage = 'PLAYOFF'
        and bracket_type = 'LOSERS'
        and ((metadata->>'wb_drop_away_round')::int) = m.round
        and ((metadata->>'wb_drop_away_slot')::int) = greatest(coalesce(m.bracket_slot, 1), 1)
      limit 1;
    end if;

    -- Compatibility fallback: legacy mapping shape.
    if target is null then
      if m.round = 1 then
        v_wb_drop_slot := ceil(greatest(coalesce(m.bracket_slot, 1), 1) / 2.0)::int;
        select id into target
        from public.matches
        where tournament_id = m.tournament_id
          and stage = 'PLAYOFF'
          and bracket_type = 'LOSERS'
          and ((metadata->>'wb_drop_round')::int) = 1
          and bracket_slot = v_wb_drop_slot
        limit 1;
      else
        select id into target
        from public.matches
        where tournament_id = m.tournament_id
          and stage = 'PLAYOFF'
          and bracket_type = 'LOSERS'
          and ((metadata->>'wb_drop_round')::int) = m.round
          and ((metadata->>'wb_drop_slot')::int) = greatest(coalesce(m.bracket_slot, 1), 1)
        limit 1;
      end if;
    end if;

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
