declare
  v_status text;
  v_n int;
  v_has_groups boolean;
  v_ranked uuid[];
  v_rank_count int;
  v_positions int[] := array[1,8,4,5,2,7,3,6];
  v_slot int;
  v_byes int;
  v_pairs int;
  v_opponents int[];
  v_home_rank int;
  v_away_rank int;
  v_home uuid;
  v_away uuid;
  v_target uuid;
  v_source record;
begin
  -- Internal helper called by result-lock triggers. Serialize the final draw;
  -- no client role has EXECUTE on this routine.
  if not exists (select 1 from public.matches where tournament_id = p_tournament_id
      and stage = 'PLAYOFF' and bracket_type = 'LOSERS' and round = 2
      and coalesce((metadata->>'placement_seed_pending')::boolean,false)) then
    return;
  end if;
  select status into v_status from public.tournaments where id = p_tournament_id for update;
  if lower(coalesce(v_status, '')) = 'closed' then
    return;
  end if;
  if not exists (select 1 from public.matches where tournament_id = p_tournament_id
      and stage = 'PLAYOFF' and bracket_type = 'LOSERS' and round = 2
      and coalesce((metadata->>'placement_seed_pending')::boolean,false)) then
    return;
  end if;
  if exists (select 1 from public.matches m join public.match_results r on r.match_id = m.id
      where m.tournament_id = p_tournament_id and m.stage = 'PLAYOFF' and m.bracket_type = 'LOSERS'
        and m.round >= 2 and r.locked) then
    return; -- Never reseed a draw that has started.
  end if;

  select count(*) into v_n from public.tournament_participants where tournament_id = p_tournament_id;
  if v_n not between 9 and 11 then
    return;
  end if;
  -- All four WB quarter-final losers and all real WB opening losers must exist.
  if (select count(*) from public.matches m join public.match_results r on r.match_id = m.id
      where m.tournament_id = p_tournament_id and m.stage = 'PLAYOFF' and m.bracket_type = 'WINNERS'
        and m.round = 2 and m.home_participant_id is not null and m.away_participant_id is not null
        and r.locked and r.home_score <> r.away_score) <> 4 then
    return;
  end if;
  if (select count(*) from public.matches m join public.match_results r on r.match_id = m.id
      where m.tournament_id = p_tournament_id and m.stage = 'PLAYOFF' and m.bracket_type = 'WINNERS'
        and m.round = 1 and m.home_participant_id is not null and m.away_participant_id is not null
        and r.locked and r.home_score <> r.away_score) <> v_n - 8 then
    return;
  end if;
  select exists(select 1 from public.tournament_groups where tournament_id = p_tournament_id) into v_has_groups;

  with pool as (
    select case when r.home_score > r.away_score then m.away_participant_id else m.home_participant_id end as participant_id
    from public.matches m join public.match_results r on r.match_id = m.id
    where m.tournament_id = p_tournament_id and m.stage = 'PLAYOFF' and m.bracket_type = 'WINNERS'
      and m.round in (1,2) and m.home_participant_id is not null and m.away_participant_id is not null
      and r.locked and r.home_score <> r.away_score
  ), overall as (
    -- Match the overall group-stage display, not the group-by-group WB seeds.
    select participant_id, row_number() over (
      order by points desc, goal_diff desc, shots_diff desc, rank_in_group asc, participant_id asc
    ) as overall_rank
    from public.v_group_standings where tournament_id = p_tournament_id
  ), ranked as (
    select p.participant_id,
      case when v_has_groups then o.overall_rank else s.seed end as overall_rank
    from pool p
    left join overall o on o.participant_id = p.participant_id
    left join public.tournament_playoff_seeds s on s.tournament_id = p_tournament_id and s.participant_id = p.participant_id
  )
  select array_agg(participant_id order by overall_rank asc, participant_id asc), count(overall_rank)
  into v_ranked, v_rank_count from ranked;
  if coalesce(array_length(v_ranked,1),0) <> v_n - 4 or v_rank_count <> v_n - 4
     or (select count(distinct p) from unnest(v_ranked) p) <> v_n - 4 then
    raise exception 'Placement draw requires a complete, uniquely ranked group-stage pool';
  end if;

  v_byes := 8 - cardinality(v_ranked);
  v_pairs := cardinality(v_ranked) - 4;
  -- BYE recipients and stronger/weaker seed bands stay fixed. Among valid
  -- opponents prefer another group, then avoid a repeat playoff opponent.
  with recursive draw(opponents, same_group, rematches, deviation) as (
    select array[]::int[], 0, 0, 0
    union all
    select d.opponents || x.rank,
      d.same_group + case when exists (
        select 1 from public.tournament_group_members a
        join public.tournament_group_members b on a.group_id = b.group_id
        where a.participant_id = v_ranked[v_byes + cardinality(d.opponents) + 1]
          and b.participant_id = v_ranked[x.rank]) then 1 else 0 end,
      d.rematches + case when exists (
        select 1 from public.matches m join public.match_results r on r.match_id = m.id
        where m.tournament_id = p_tournament_id and m.stage = 'PLAYOFF' and r.locked
          and (m.home_participant_id, m.away_participant_id) in (
            (v_ranked[v_byes + cardinality(d.opponents) + 1], v_ranked[x.rank]),
            (v_ranked[x.rank], v_ranked[v_byes + cardinality(d.opponents) + 1]))) then 1 else 0 end,
      d.deviation + abs(v_byes + cardinality(d.opponents) + 1 + x.rank - 9)
    from draw d cross join generate_series(5, cardinality(v_ranked)) x(rank)
    where cardinality(d.opponents) < v_pairs and not x.rank = any(d.opponents)
  )
  select opponents into v_opponents from draw where cardinality(opponents) = v_pairs
    order by same_group, rematches, deviation, opponents limit 1;

  -- Seed six/five/seven entrants into an eight-slot tree. The strongest
  -- 8 - pool_size entrants receive the only BYEs; the remaining entrants play.
  for v_slot in 1..4 loop
    v_home_rank := v_positions[v_slot*2-1];
    v_away_rank := case when v_home_rank > v_byes
      then v_opponents[v_home_rank-v_byes] else v_positions[v_slot*2] end;
    v_home := v_ranked[v_home_rank];
    v_away := v_ranked[v_away_rank];
    update public.matches
    set home_participant_id = v_home, away_participant_id = v_away,
        metadata = metadata || jsonb_build_object('placement_seed_pending',false,
          'placement_bye',v_home is null or v_away is null,
          'placement_pool_seed_home',case when v_home is not null then v_home_rank end,
          'placement_pool_seed_away',case when v_away is not null then v_away_rank end)
    where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS'
      and round = 2 and bracket_slot = v_slot
    returning id into v_target;
    perform public.sync_match_identities_from_participants(v_target);
    perform public.balance_match_home_away(v_target);
  end loop;

  -- Record the direct WB quarter-final source on the drawn side for audit
  -- and dependency checks; opening losers arrive through their BYE nodes.
  for v_source in
    select m.round, m.bracket_slot,
      case when r.home_score > r.away_score then m.away_participant_id else m.home_participant_id end as participant_id
    from public.matches m join public.match_results r on r.match_id = m.id
    where m.tournament_id = p_tournament_id and m.stage = 'PLAYOFF'
      and m.bracket_type = 'WINNERS' and m.round = 2 and r.locked
  loop
    update public.matches target
    set metadata = metadata || jsonb_build_object(
      'wb_drop_' || case when target.home_participant_id = v_source.participant_id then 'home' else 'away' end || '_round',2,
      'wb_drop_' || case when target.home_participant_id = v_source.participant_id then 'home' else 'away' end || '_slot',v_source.bracket_slot)
    where target.tournament_id = p_tournament_id and target.stage = 'PLAYOFF' and target.bracket_type = 'LOSERS'
      and target.round = 2 and v_source.participant_id in (target.home_participant_id,target.away_participant_id);
  end loop;

  -- Opening losers retain visible BYE nodes. Wire them to their newly drawn
  -- quarter-final position only after the complete pool has been ranked.
  for v_source in select id, coalesce(home_participant_id,away_participant_id) as participant_id
    from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF'
      and bracket_type = 'LOSERS' and round = 1
  loop
    update public.matches source
    set next_match_id = target.id,
        next_match_side = case when target.home_participant_id = v_source.participant_id then 'HOME' else 'AWAY' end
    from public.matches target
    where source.id = v_source.id and target.tournament_id = p_tournament_id and target.stage = 'PLAYOFF'
      and target.bracket_type = 'LOSERS' and target.round = 2
      and v_source.participant_id in (target.home_participant_id,target.away_participant_id);
  end loop;
  perform public.advance_playoff_byes(p_tournament_id);
end;
