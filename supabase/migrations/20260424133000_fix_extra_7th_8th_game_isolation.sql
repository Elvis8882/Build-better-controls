-- Keep full_with_losers placement tree intact and isolate extra 7th/8th game for 8 participants.
create or replace function public.trg_place_losers_into_losers_bracket()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
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
  v_parent_round int;
  v_parent_slot int;
  v_parent_id uuid;
  v_round_slot_pos int;
  v_round_slot_total int;
  v_drop_preferred_side text;
  v_team_based boolean := false;
  v_participant_count int := 0;
  v_lb_round1_slot1_loser uuid;
  v_lb_round1_slot2_loser uuid;
  v_lb_extra_match_id uuid;
  v_lb_final_round int;
  v_lb_extra_round int;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'PLAYOFF' then
    return new;
  end if;

  select
    preset_id,
    public.preset_is_full_with_losers(preset_id),
    public.preset_is_team_based(preset_id)
  into v_preset, v_is_full_with_losers, v_team_based
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

    if v_is_full_with_losers then
      if v_team_based then
        select count(*)
        into v_participant_count
        from (
          select distinct tp.team_id
          from public.tournament_participants tp
          where tp.tournament_id = m.tournament_id
            and tp.team_id is not null
        ) teams;
      else
        select count(*)
        into v_participant_count
        from public.tournament_participants tp
        where tp.tournament_id = m.tournament_id;
      end if;

      -- 8-participant special case:
      -- add one detached 7th/8th game in the same final placement round,
      -- underneath the 3rd/4th game (slot 2 in final round).
      if v_participant_count = 8 then
        with round1_losers as (
          select
            mx.bracket_slot,
            case
              when mr.home_score > mr.away_score then mx.away_participant_id
              when mr.away_score > mr.home_score then mx.home_participant_id
              else null
            end as loser_participant_id
          from public.matches mx
          join public.match_results mr
            on mr.match_id = mx.id
          where mx.tournament_id = m.tournament_id
            and mx.stage = 'PLAYOFF'
            and mx.bracket_type = 'LOSERS'
            and mx.round = 1
            and mx.bracket_slot in (1, 2)
            and mr.locked = true
            and mr.home_score <> mr.away_score
        )
        select
          (array_agg(loser_participant_id) filter (where bracket_slot = 1))[1],
          (array_agg(loser_participant_id) filter (where bracket_slot = 2))[1]
        into v_lb_round1_slot1_loser, v_lb_round1_slot2_loser
        from round1_losers;

        select coalesce(max(mx.round), 1)
        into v_lb_final_round
        from public.matches mx
        where mx.tournament_id = m.tournament_id
          and mx.stage = 'PLAYOFF'
          and mx.bracket_type = 'LOSERS'
          and coalesce((mx.metadata->>'is_gf2')::boolean, false) = false
          and coalesce((mx.metadata->>'is_additional_placement')::boolean, false) = false;

        if v_lb_round1_slot1_loser is not null
           and v_lb_round1_slot2_loser is not null
           and v_lb_round1_slot1_loser is distinct from v_lb_round1_slot2_loser then
          -- Root-cause fix:
          -- never reuse a structural LOSERS-tree node for the extra 7th/8th game.
          -- We place it in the final round's detached slot so it is visually
          -- separated from the placement playoff tree and cannot overwrite
          -- structural tree metadata/participants.
          v_lb_extra_round := greatest(coalesce(v_lb_final_round, 1), 2);

          insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot, metadata)
          select
            m.tournament_id,
            'PLAYOFF',
            'LOSERS',
            v_lb_extra_round,
            2,
            jsonb_build_object(
              'classification', 'extra_7th_place_game',
              'is_additional_placement', true,
              'round_label', '7th/8th game',
              'lb_loss_home_round', 1,
              'lb_loss_home_slot', 1,
              'lb_loss_away_round', 1,
              'lb_loss_away_slot', 2
            )
          where not exists (
            select 1
            from public.matches mx
            where mx.tournament_id = m.tournament_id
              and mx.stage = 'PLAYOFF'
              and mx.bracket_type = 'LOSERS'
              and coalesce((mx.metadata->>'is_additional_placement')::boolean, false) = true
              and coalesce((mx.metadata->>'classification') = 'extra_7th_place_game', false)
          )
          returning id into v_lb_extra_match_id;

          if v_lb_extra_match_id is null then
            select id
            into v_lb_extra_match_id
            from public.matches mx
            where mx.tournament_id = m.tournament_id
              and mx.stage = 'PLAYOFF'
              and mx.bracket_type = 'LOSERS'
              and coalesce((mx.metadata->>'is_additional_placement')::boolean, false) = true
              and coalesce((mx.metadata->>'classification') = 'extra_7th_place_game', false)
            order by mx.round desc, mx.bracket_slot asc
            limit 1;
          end if;

          if v_lb_extra_match_id is not null then
            update public.matches
            set home_participant_id = v_lb_round1_slot1_loser,
                away_participant_id = v_lb_round1_slot2_loser,
                next_match_id = null,
                next_match_side = null,
                metadata = coalesce(metadata, '{}'::jsonb)
                  || jsonb_build_object(
                    'classification', 'extra_7th_place_game',
                    'is_additional_placement', true,
                    'round_label', '7th/8th game',
                    'lb_loss_home_round', 1,
                    'lb_loss_home_slot', 1,
                    'lb_loss_away_round', 1,
                    'lb_loss_away_slot', 2
                  )
            where id = v_lb_extra_match_id;

            perform public.sync_match_identities_from_participants(v_lb_extra_match_id);
            perform public.balance_match_home_away(v_lb_extra_match_id);
          end if;
        end if;
      end if;
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
    -- Winners losers are routed via precomputed metadata mapping authored by
    -- ensure_playoff_bracket. This keeps bracket progression deterministic for
    -- all sizes 3..16 and prevents BYE-only winners nodes from emitting losers.
    select id,
           case
             when (metadata->>'wb_drop_home_round')::int = m.round
              and (metadata->>'wb_drop_home_slot')::int = m.bracket_slot then 'HOME'
             when (metadata->>'wb_drop_away_round')::int = m.round
              and (metadata->>'wb_drop_away_slot')::int = m.bracket_slot then 'AWAY'
             else null
           end as mapped_side
    into target, v_drop_preferred_side
    from public.matches
    where tournament_id = m.tournament_id
      and stage = 'PLAYOFF'
      and bracket_type = 'LOSERS'
      and (
        (
          metadata ? 'wb_drop_home_round'
          and metadata ? 'wb_drop_home_slot'
          and (metadata->>'wb_drop_home_round')::int = m.round
          and (metadata->>'wb_drop_home_slot')::int = m.bracket_slot
        )
        or
        (
          metadata ? 'wb_drop_away_round'
          and metadata ? 'wb_drop_away_slot'
          and (metadata->>'wb_drop_away_round')::int = m.round
          and (metadata->>'wb_drop_away_slot')::int = m.bracket_slot
        )
      )
    limit 1;

    if target is null then
      perform public.advance_playoff_byes(m.tournament_id);
      return new;
    end if;

    v_target_side := case
      when target is null then null
      when v_drop_preferred_side = 'HOME'
        and exists (select 1 from public.matches tm where tm.id = target and tm.home_participant_id is null)
      then 'HOME'
      when v_drop_preferred_side = 'AWAY'
        and exists (select 1 from public.matches tm where tm.id = target and tm.away_participant_id is null)
      then 'AWAY'
      when exists (select 1 from public.matches tm where tm.id = target and tm.home_participant_id is null)
      then 'HOME'
      when exists (select 1 from public.matches tm where tm.id = target and tm.away_participant_id is null)
      then 'AWAY'
      else v_drop_preferred_side
    end;

    if target is not null and v_target_side is not null then
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

$function$;
