-- Preserve ranked hierarchy while mixing groups and assign home by advancement stage.

create or replace function public.sync_match_identities_from_participants(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  m record;
  hp record;
  ap record;
begin
  select * into m from public.matches where id = p_match_id;
  if not found then return; end if;

  -- Always assign both records. A BYE has a null participant on one side;
  -- SELECT with no row supplies typed nulls and clears stale identities.
  select user_id, guest_id into hp from public.tournament_participants
    where id = m.home_participant_id;
  select user_id, guest_id into ap from public.tournament_participants
    where id = m.away_participant_id;
  update public.matches set home_user_id = hp.user_id, home_guest_id = hp.guest_id,
    away_user_id = ap.user_id, away_guest_id = ap.guest_id where id = p_match_id;
end;
$function$;

create or replace function public.balance_match_home_away(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  m record;
  v_home_seed bigint;
  v_away_seed bigint;
  v_home_loss int;
  v_away_loss int;
  v_swap boolean := false;
  v_metadata jsonb;
  v_key text;
  v_other text;
begin
  select * into m from public.matches where id = p_match_id;
  if m.id is null or m.home_participant_id is null or m.away_participant_id is null then
    return;
  end if;
  if exists (select 1 from public.match_results where match_id = m.id and locked)
     or exists (select 1 from public.tournaments where id = m.tournament_id
       and lower(coalesce(status, '')) = 'closed') then
    return;
  end if;

  -- A later actual WB defeat has home priority in the placement bracket.
  -- BYEs, pending games and tied results cannot establish a defeat stage.
  if m.stage = 'PLAYOFF' and m.bracket_type = 'LOSERS' then
    select max(w.round) filter (where loser.id = m.home_participant_id),
           max(w.round) filter (where loser.id = m.away_participant_id)
    into v_home_loss, v_away_loss
    from public.matches w join public.match_results r on r.match_id = w.id
    cross join lateral (select case when r.home_score > r.away_score
      then w.away_participant_id else w.home_participant_id end as id) loser
    where w.tournament_id = m.tournament_id and w.stage = 'PLAYOFF'
      and w.bracket_type = 'WINNERS' and w.home_participant_id is not null
      and w.away_participant_id is not null and r.locked and r.home_score <> r.away_score;
  end if;
  if v_home_loss is not null and v_away_loss is not null and v_home_loss <> v_away_loss then
    v_swap := v_away_loss > v_home_loss;
  else
    -- Use the same overall ordering as the group-stage standings display.
    with ranked as (
      select participant_id, row_number() over (order by points desc,
        goal_diff desc, shots_diff desc, rank_in_group asc, participant_id asc) as seed
      from public.v_group_standings where tournament_id = m.tournament_id
    )
    select max(seed) filter (where participant_id = m.home_participant_id),
           max(seed) filter (where participant_id = m.away_participant_id)
    into v_home_seed, v_away_seed from ranked;
    if v_home_seed is null or v_away_seed is null then
      select max(seed) filter (where participant_id = m.home_participant_id),
             max(seed) filter (where participant_id = m.away_participant_id)
      into v_home_seed, v_away_seed from public.tournament_playoff_seeds
      where tournament_id = m.tournament_id;
    end if;
    v_swap := case when v_home_seed is not null and v_away_seed is not null
      then v_away_seed < v_home_seed else m.away_participant_id < m.home_participant_id end;
  end if;
  if not v_swap then return; end if;

  -- Side-specific dependencies must follow the participant when sides change.
  v_metadata := coalesce(m.metadata, '{}'::jsonb);
  for v_key in select jsonb_object_keys(v_metadata) loop
    if v_key like '%_home%' then
      v_other := replace(v_key, '_home', '_away');
    elsif v_key like '%_away%' then
      v_other := replace(v_key, '_away', '_home');
    else continue;
    end if;
    v_metadata := v_metadata - v_key;
  end loop;
  for v_key in select jsonb_object_keys(coalesce(m.metadata, '{}'::jsonb)) loop
    if v_key like '%_home%' then v_other := replace(v_key, '_home', '_away');
    elsif v_key like '%_away%' then v_other := replace(v_key, '_away', '_home');
    else continue;
    end if;
    v_metadata := v_metadata || jsonb_build_object(v_other, m.metadata->v_key);
  end loop;
  update public.matches set home_participant_id = m.away_participant_id,
    away_participant_id = m.home_participant_id, metadata = v_metadata where id = m.id;
  update public.matches set next_match_side = case next_match_side
    when 'HOME' then 'AWAY' when 'AWAY' then 'HOME' else next_match_side end
    where next_match_id = m.id;
  perform public.sync_match_identities_from_participants(m.id);
end;
$function$;

create or replace function public.seed_cross_group_winners_round1(p_tournament_id uuid, p_eligible_ids uuid[])
returns uuid[]
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_ids uuid[];
  v_groups uuid[];
  v_n int;
  v_byes int;
  v_size int := 1;
  v_half int;
  v_quarters int;
  v_opponents int[];
  v_paths int[];
  v_top int[] := array[1,4,2,3];
  v_anchor int;
  v_partner int;
  v_slot int;
  v_id uuid;
begin
  -- Internal, invoker-only helper; caller owns the generation authorization.
  -- Rank eligible entrants globally, rather than concatenating whole groups.
  select array_agg(s.participant_id order by s.points desc, s.goal_diff desc,
           s.shots_diff desc, s.rank_in_group asc, s.participant_id asc),
         array_agg(gm.group_id order by s.points desc, s.goal_diff desc,
           s.shots_diff desc, s.rank_in_group asc, s.participant_id asc)
  into v_ids, v_groups
  from public.v_group_standings s
  join public.tournament_group_members gm on gm.participant_id = s.participant_id
  join public.tournament_groups g on g.id = gm.group_id and g.tournament_id = p_tournament_id
  where s.tournament_id = p_tournament_id and s.participant_id = any(p_eligible_ids);
  v_n := cardinality(v_ids);
  if v_n is null or v_n <> cardinality(p_eligible_ids)
     or (select count(distinct id) from unnest(v_ids) id) <> v_n or v_n not between 3 and 16 then
    raise exception 'Cross-group draw requires 3–16 uniquely ranked group participants';
  end if;
  while v_size < v_n loop v_size := v_size * 2; end loop;
  v_half := v_size / 2;
  v_quarters := v_size / 4;
  v_top := case v_size when 16 then array[1,4,2,3] when 8 then array[1,2] else array[1] end;
  v_byes := v_size - v_n;

  -- Keep the stronger half on separate opening paths. Only lower-half
  -- entrants can be assigned as their opponents. Optimize all assignments
  -- together so a greedy choice cannot force an avoidable same-group game.
  with recursive draw(opponents, repeats, deviation) as (
    select array[]::int[], 0, 0
    union all
    select d.opponents || x.rank,
      d.repeats + case when v_groups[v_byes + cardinality(d.opponents) + 1] = v_groups[x.rank] then 1 else 0 end,
      d.deviation + abs(v_byes + cardinality(d.opponents) + 1 + x.rank - v_size - 1)
    from draw d cross join generate_series(v_half+1, v_n) x(rank)
    where cardinality(d.opponents) < v_n - v_half and not x.rank = any(d.opponents)
  )
  select opponents into v_opponents from draw where cardinality(opponents) = v_n - v_half
    order by repeats, deviation, opponents limit 1;

  -- Fix the top quarter of seeds in separate branches (1 and 2 in
  -- opposite halves). Assign the remaining stronger-half paths to those
  -- branches, preferring cross-group meetings in the next round, then
  -- the conventional strongest-versus-weakest pairing.
  with recursive draw(paths, repeats, deviation) as (
    select array[]::int[], 0, 0
    union all
    select d.paths || x.rank,
      d.repeats + (select count(*)::int from unnest(array[
        v_groups[v_top[cardinality(d.paths)+1]],
        v_groups[v_opponents[v_top[cardinality(d.paths)+1]-v_byes]]]) a(g)
        cross join unnest(array[v_groups[x.rank], v_groups[v_opponents[x.rank-v_byes]]]) b(g)
        where a.g = b.g),
      d.deviation + abs(x.rank + v_top[cardinality(d.paths)+1] - v_half - 1)
    from draw d cross join generate_series(v_quarters+1,v_half) x(rank)
    where cardinality(d.paths) < v_quarters and not x.rank = any(d.paths)
  )
  select paths into v_paths from draw where cardinality(paths) = v_quarters
    order by repeats, deviation, paths limit 1;

  for v_slot in 1..v_half loop
    v_anchor := case when v_slot % 2 = 1 then v_top[(v_slot+1)/2] else v_paths[v_slot/2] end;
    v_partner := case when v_anchor > v_byes then v_opponents[v_anchor-v_byes] end;
    update public.matches set home_participant_id = v_ids[v_anchor],
      away_participant_id = v_ids[v_partner],
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('draw_policy','cross_group_ranked')
    where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'WINNERS'
      and round = 1 and bracket_slot = v_slot returning id into v_id;
    perform public.sync_match_identities_from_participants(v_id);
    perform public.balance_match_home_away(v_id);
  end loop;
  return v_ids;
end;
$function$;

create or replace function public.seed_placement_quarterfinals(p_tournament_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $function$
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
$function$;

create or replace function public.ensure_playoff_bracket(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
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
  v_drop_side text;
  v_group_count int := 0;
  v_mixed_draw boolean := false;
  v_group_a uuid;
  v_group_b uuid;
  v_max_group_rank int := 0;
  v_rank int;
  v_anchor_seed int;
  v_anchor_participant uuid;
  v_anchor_group uuid;
  v_opponent_participant uuid;
  v_opponent_group uuid;
  v_order_seed int;
  v_slot_branch int;
  v_assigned_refs int;
  v_distinct_assigned int;
  v_expected_null_null_slots int;
  v_actual_null_null_slots int;
  v_seed uuid;
  v_seed_occurrences int;
  v_expected_home uuid;
  v_expected_away uuid;
  v_tokens jsonb[];
  v_next_tokens jsonb[];
  v_drops jsonb[];
  v_sources jsonb[];
  v_token jsonb;
  v_phase int;
  v_pair_count int;
  v_side_index int;
  v_display_round int;
  v_round_label text;
begin
  -- Developer note:
  -- Group Stage qualification/seeding flow is intentionally preserved.
  -- Full-with-losers placement supports 3..16 entrants. Build it after seeding
  -- so source occupancy reflects the actual group-specific winners layout.

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

  -- Prune stale winners rows from previously larger brackets before relinking
  -- and validating round-1 population.
  delete from public.matches m
  where m.tournament_id = p_tournament_id
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and (
      m.round is null
      or m.round < 1
      or m.round > v_rounds
      or m.bracket_slot is null
      or m.bracket_slot < 1
      or m.bracket_slot > (v_s / (2^m.round))
    );

  -- Keep only one winners match row per structural slot.
  -- Historical data may contain duplicate (round, bracket_slot) rows, which can
  -- inflate round-1 assignment validation counts (assigned_refs > participant_count).
  delete from public.matches m
  using (
    select id
    from (
      select
        mx.id,
        row_number() over (
          partition by mx.round, mx.bracket_slot
          order by mx.id asc
        ) as rn
      from public.matches mx
      where mx.tournament_id = p_tournament_id
        and mx.stage = 'PLAYOFF'
        and mx.bracket_type = 'WINNERS'
    ) ranked
    where ranked.rn > 1
  ) dup
  where m.id = dup.id;

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

  v_matches_in_round := v_s / 2;
  if v_has_group then
    drop table if exists tmp_group_ranked;
    create temporary table tmp_group_ranked (
      seed int not null,
      participant_id uuid not null,
      group_id uuid not null,
      group_code text not null,
      group_rank int not null
    ) on commit drop;

    drop table if exists tmp_r1_pairs;
    create temporary table tmp_r1_pairs (
      bracket_slot int primary key,
      home_participant_id uuid,
      away_participant_id uuid
    ) on commit drop;

    insert into tmp_group_ranked(seed, participant_id, group_id, group_code, group_rank)
    with seeded as (
      select
        ps.seed,
        ps.participant_id,
        tg.id as group_id,
        tg.group_code
      from public.v_playoff_seeds ps
      join public.tournament_group_members tgm
        on tgm.participant_id = ps.participant_id
      join public.tournament_groups tg
        on tg.id = tgm.group_id
      where ps.tournament_id = p_tournament_id
    )
    select
      s.seed,
      s.participant_id,
      s.group_id,
      s.group_code,
      row_number() over (
        partition by s.group_id
        order by s.seed asc, s.participant_id asc
      )::int as group_rank
    from seeded s;

    select count(distinct group_id) into v_group_count
    from tmp_group_ranked;

    if v_group_count = 1 then
      -- Single-group playoffs should still use canonical seed-tree placement so
      -- odd-size BYEs are granted to strongest ranks first (rank #1, then #2, ...).
      v_seed_positions := array[1, 2];
      while array_length(v_seed_positions, 1) < v_s loop
        v_next_positions := '{}'::int[];
        foreach v_pos in array v_seed_positions loop
          v_next_positions := array_append(v_next_positions, v_pos);
          v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
        end loop;
        v_seed_positions := v_next_positions;
      end loop;

      for v_slot in 1..v_matches_in_round loop
        insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
        values (
          v_slot,
          (
            select gr.participant_id
            from tmp_group_ranked gr
            where gr.seed = v_seed_positions[(v_slot - 1) * 2 + 1]
          ),
          case
            when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then (
              select gr.participant_id
              from tmp_group_ranked gr
              where gr.seed = v_seed_positions[(v_slot - 1) * 2 + 2]
            )
            else null
          end
        );
      end loop;
    elsif v_group_count = 2 then
      select grp.group_id into v_group_a
      from (
        select group_id, min(group_code) as group_code
        from tmp_group_ranked
        group by group_id
      ) grp
      order by grp.group_code asc, grp.group_id asc
      limit 1;

      select grp.group_id into v_group_b
      from (
        select group_id, min(group_code) as group_code
        from tmp_group_ranked
        where group_id <> v_group_a
        group by group_id
      ) grp
      order by grp.group_code asc, grp.group_id asc
      limit 1;

      select greatest(
        coalesce((select max(group_rank) from tmp_group_ranked where group_id = v_group_a), 0),
        coalesce((select max(group_rank) from tmp_group_ranked where group_id = v_group_b), 0)
      ) into v_max_group_rank;

      if v_n < 7 then
        -- For 5/6 qualifiers we keep the normalized-tree slot shape so top seeds
        -- receive round-1 BYEs in the canonical 8-slot bracket layout.
        v_seed_positions := array[1, 2];
        while array_length(v_seed_positions, 1) < v_s loop
          v_next_positions := '{}'::int[];
          foreach v_pos in array v_seed_positions loop
            v_next_positions := array_append(v_next_positions, v_pos);
            v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
          end loop;
          v_seed_positions := v_next_positions;
        end loop;

        for v_slot in 1..v_matches_in_round loop
          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (
            v_slot,
            (
              select gr.participant_id
              from tmp_group_ranked gr
              where gr.seed = v_seed_positions[(v_slot - 1) * 2 + 1]
            ),
            case
              when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then (
                select gr.participant_id
                from tmp_group_ranked gr
                where gr.seed = v_seed_positions[(v_slot - 1) * 2 + 2]
              )
              else null
            end
          );
        end loop;
      elsif v_s = 16 then
        -- For normalized 16-slot brackets (9..16 qualifiers), always materialize
        -- all structural round-1 slots and encode BYEs as one-sided matches.
        --
        -- Build a full ordered seed list across both groups without truncating at
        -- any specific rank, then project it through canonical seed-tree positions.
        select array_agg(x.participant_id order by x.group_rank asc, x.group_order asc) into v_seeded
        from (
          select
            gr.participant_id,
            gr.group_rank,
            case when gr.group_id = v_group_a then 1 else 2 end as group_order
          from tmp_group_ranked gr
          where gr.group_id in (v_group_a, v_group_b)
        ) x;

        v_seed_positions := array[1, 2];
        while array_length(v_seed_positions, 1) < v_s loop
          v_next_positions := '{}'::int[];
          foreach v_pos in array v_seed_positions loop
            v_next_positions := array_append(v_next_positions, v_pos);
            v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
          end loop;
          v_seed_positions := v_next_positions;
        end loop;

        for v_slot in 1..v_matches_in_round loop
          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (
            v_slot,
            case
              when v_seed_positions[(v_slot - 1) * 2 + 1] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 1]]
              else null
            end,
            case
              when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 2]]
              else null
            end
          );
        end loop;
      else
        for v_rank in 1..v_max_group_rank loop
          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (
            v_rank,
            (select participant_id from tmp_group_ranked where group_id = v_group_a and group_rank = v_rank),
            (select participant_id from tmp_group_ranked where group_id = v_group_b and group_rank = (v_max_group_rank + 1 - v_rank))
          );
        end loop;
      end if;
    else
      drop table if exists tmp_unpaired_pool;
      create temporary table tmp_unpaired_pool (
        seed int primary key,
        participant_id uuid not null,
        group_id uuid not null
      ) on commit drop;

      insert into tmp_unpaired_pool(seed, participant_id, group_id)
      select seed, participant_id, group_id
      from tmp_group_ranked
      order by seed asc;

      if v_s = 16 then
        drop table if exists tmp_ordered_participants;
        create temporary table tmp_ordered_participants (
          seed int primary key,
          participant_id uuid not null,
          group_id uuid not null
        ) on commit drop;

        v_slot := 1;
        v_order_seed := 1;
        while exists (select 1 from tmp_unpaired_pool) loop
          select seed, participant_id, group_id
          into v_anchor_seed, v_anchor_participant, v_anchor_group
          from tmp_unpaired_pool
          order by seed asc
          limit 1;

          delete from tmp_unpaired_pool where seed = v_anchor_seed;

          insert into tmp_ordered_participants(seed, participant_id, group_id)
          values (v_order_seed, v_anchor_participant, v_anchor_group);
          v_order_seed := v_order_seed + 1;

          v_opponent_participant := null;
          v_opponent_group := null;
          if exists (select 1 from tmp_unpaired_pool) then
            v_slot_branch := case when v_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end;

            select cand.participant_id, cand.group_id
            into v_opponent_participant, v_opponent_group
            from tmp_unpaired_pool cand
            left join lateral (
              select count(*)::int as branch_group_count
              from tmp_r1_pairs p
              join tmp_group_ranked grh
                on grh.participant_id = p.home_participant_id
              where (case when p.bracket_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end) = v_slot_branch
                and grh.group_id = cand.group_id
            ) h on true
            left join lateral (
              select count(*)::int as branch_group_count
              from tmp_r1_pairs p
              join tmp_group_ranked gra
                on gra.participant_id = p.away_participant_id
              where (case when p.bracket_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end) = v_slot_branch
                and gra.group_id = cand.group_id
            ) a on true
            order by
              case when cand.group_id = v_anchor_group then 1 else 0 end asc,
              (coalesce(h.branch_group_count, 0) + coalesce(a.branch_group_count, 0)) asc,
              cand.seed desc,
              cand.participant_id asc
            limit 1;

            delete from tmp_unpaired_pool where participant_id = v_opponent_participant;

            insert into tmp_ordered_participants(seed, participant_id, group_id)
            values (v_order_seed, v_opponent_participant, v_opponent_group);
            v_order_seed := v_order_seed + 1;
          end if;

          -- Keep tie-break diversity accounting on real pair selections only.
          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (v_slot, v_anchor_participant, v_opponent_participant)
          on conflict (bracket_slot) do update
            set home_participant_id = excluded.home_participant_id,
                away_participant_id = excluded.away_participant_id;

          v_slot := v_slot + 1;
        end loop;

        v_seed_positions := array[1, 2];
        while array_length(v_seed_positions, 1) < v_s loop
          v_next_positions := '{}'::int[];
          foreach v_pos in array v_seed_positions loop
            v_next_positions := array_append(v_next_positions, v_pos);
            v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
          end loop;
          v_seed_positions := v_next_positions;
        end loop;

        for v_slot in 1..v_matches_in_round loop
          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (
            v_slot,
            case
              when v_seed_positions[(v_slot - 1) * 2 + 1] <= v_n then (
                select op.participant_id
                from tmp_ordered_participants op
                where op.seed = v_seed_positions[(v_slot - 1) * 2 + 1]
              )
              else null
            end,
            case
              when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then (
                select op.participant_id
                from tmp_ordered_participants op
                where op.seed = v_seed_positions[(v_slot - 1) * 2 + 2]
              )
              else null
            end
          )
          on conflict (bracket_slot) do update
            set home_participant_id = excluded.home_participant_id,
                away_participant_id = excluded.away_participant_id;
        end loop;
      else
        v_slot := 1;
        while exists (select 1 from tmp_unpaired_pool) and v_slot <= v_matches_in_round loop
          select seed, participant_id, group_id
          into v_anchor_seed, v_anchor_participant, v_anchor_group
          from tmp_unpaired_pool
          order by seed asc
          limit 1;

          delete from tmp_unpaired_pool where seed = v_anchor_seed;

          if exists (select 1 from tmp_unpaired_pool) then
            v_slot_branch := case when v_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end;

            select cand.participant_id
            into v_opponent_participant
            from tmp_unpaired_pool cand
            left join lateral (
              select count(*)::int as branch_group_count
              from tmp_r1_pairs p
              join tmp_group_ranked grh
                on grh.participant_id = p.home_participant_id
              where (case when p.bracket_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end) = v_slot_branch
                and grh.group_id = cand.group_id
            ) h on true
            left join lateral (
              select count(*)::int as branch_group_count
              from tmp_r1_pairs p
              join tmp_group_ranked gra
                on gra.participant_id = p.away_participant_id
              where (case when p.bracket_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end) = v_slot_branch
                and gra.group_id = cand.group_id
            ) a on true
            order by
              case when cand.group_id = v_anchor_group then 1 else 0 end asc,
              (coalesce(h.branch_group_count, 0) + coalesce(a.branch_group_count, 0)) asc,
              cand.seed desc,
              cand.participant_id asc
            limit 1;

            delete from tmp_unpaired_pool where participant_id = v_opponent_participant;
          else
            v_opponent_participant := null;
          end if;

          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (v_slot, v_anchor_participant, v_opponent_participant);

          v_slot := v_slot + 1;
        end loop;
      end if;
    end if;

    for v_slot in 1..v_matches_in_round loop
      select p.home_participant_id, p.away_participant_id
      into v_home, v_away
      from tmp_r1_pairs p
      where p.bracket_slot = v_slot;

      if not found then
        v_home := null;
        v_away := null;
      end if;

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
  else
    v_seed_positions := array[1, 2];
    while array_length(v_seed_positions, 1) < v_s loop
      v_next_positions := '{}'::int[];
      foreach v_pos in array v_seed_positions loop
        v_next_positions := array_append(v_next_positions, v_pos);
        v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
      end loop;
      v_seed_positions := v_next_positions;
    end loop;

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
  end if;

  if v_is_full_with_losers and v_n between 3 and 16 and v_group_count > 1 then
    v_seeded := public.seed_cross_group_winners_round1(p_tournament_id, v_seeded);
    v_mixed_draw := true;
  end if;

  if v_is_full_with_losers and v_n between 9 and 16 then
    -- The lateral join emits one row per occupied side. Count those references
    -- directly; summing match occupancy here counts full matches twice.
    select
      count(x.pid),
      count(distinct x.pid)
    into v_assigned_refs, v_distinct_assigned
    from public.matches m
    left join lateral (
      select m.home_participant_id as pid
      where m.home_participant_id is not null
      union all
      select m.away_participant_id as pid
      where m.away_participant_id is not null
    ) x on true
    where m.tournament_id = p_tournament_id
      and m.stage = 'PLAYOFF'
      and m.bracket_type = 'WINNERS'
      and m.round = 1
      and m.bracket_slot between 1 and v_matches_in_round;

    if v_assigned_refs <> v_n then
      raise exception
        'Round-1 winners assignment mismatch for tournament %: assigned_refs=% expected=% distinct_assigned=%',
        p_tournament_id, v_assigned_refs, v_n, v_distinct_assigned
        using errcode = 'P0001';
    end if;

    if v_seeded is null or coalesce(array_length(v_seeded, 1), 0) <> v_n then
      raise exception
        'Round-1 winners assignment mismatch for tournament %: seeded_count=% expected=%',
        p_tournament_id, coalesce(array_length(v_seeded, 1), 0), v_n
        using errcode = 'P0001';
    end if;

    foreach v_seed in array v_seeded loop
      select coalesce(count(*), 0)
      into v_seed_occurrences
      from public.matches m
      where m.tournament_id = p_tournament_id
        and m.stage = 'PLAYOFF'
        and m.bracket_type = 'WINNERS'
        and m.round = 1
        and m.bracket_slot between 1 and v_matches_in_round
        and (m.home_participant_id = v_seed or m.away_participant_id = v_seed);

      if v_seed_occurrences <> 1 then
        raise exception
          'Round-1 winners assignment mismatch for tournament %: participant % occurs % times (expected 1)',
          p_tournament_id, v_seed, v_seed_occurrences
          using errcode = 'P0001';
      end if;
    end loop;

    v_expected_null_null_slots := 0;
    for v_slot in 1..v_matches_in_round loop
      v_expected_home := case
        when v_seed_positions[(v_slot - 1) * 2 + 1] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 1]]
        else null
      end;
      v_expected_away := case
        when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 2]]
        else null
      end;

      if v_expected_home is null and v_expected_away is null then
        v_expected_null_null_slots := v_expected_null_null_slots + 1;
      end if;

      if not v_mixed_draw and exists (
        select 1
        from public.matches m
        where m.tournament_id = p_tournament_id
          and m.stage = 'PLAYOFF'
          and m.bracket_type = 'WINNERS'
          and m.round = 1
          and m.bracket_slot = v_slot
          and (
            ((m.home_participant_id is null) <> (v_expected_home is null))
            or ((m.away_participant_id is null) <> (v_expected_away is null))
          )
      ) then
        raise exception
          'Round-1 winners null-slot mismatch for tournament % at slot % (expected home_null=% away_null=%)',
          p_tournament_id, v_slot, (v_expected_home is null), (v_expected_away is null)
          using errcode = 'P0001';
      end if;
    end loop;

    select count(*)
    into v_actual_null_null_slots
    from public.matches m
    where m.tournament_id = p_tournament_id
      and m.stage = 'PLAYOFF'
      and m.bracket_type = 'WINNERS'
      and m.round = 1
      and m.bracket_slot between 1 and v_matches_in_round
      and m.home_participant_id is null
      and m.away_participant_id is null;

    if v_actual_null_null_slots <> v_expected_null_null_slots then
      raise exception
        'Round-1 winners null-slot mismatch for tournament %: actual_null_null_slots=% expected_null_null_slots=%',
        p_tournament_id, v_actual_null_null_slots, v_expected_null_null_slots
        using errcode = 'P0001';
    end if;
  end if;

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

  -- A placement match that is played has two sources. Alternate loser intake and
  -- consolidation. Preserve one-source BYE nodes in their original round;
  -- only wholly empty nodes are omitted. Each token has exactly one path.
  if v_is_full_with_losers and v_n between 3 and 16 then
    delete from public.playoff_placement_entrants where tournament_id = p_tournament_id;
    delete from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS';

    -- Use the actual seeded layout, including group-specific pairings.
    v_leaf_alive := '{}'::int[];
    for v_slot in 1..(v_s / 2) loop
      select home_participant_id, away_participant_id into v_home, v_away
      from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF'
        and bracket_type = 'WINNERS' and round = 1 and bracket_slot = v_slot;
      v_leaf_alive := array_append(v_leaf_alive, case when v_home is null then 0 else 1 end);
      v_leaf_alive := array_append(v_leaf_alive, case when v_away is null then 0 else 1 end);
    end loop;

    v_tokens := '{}'::jsonb[];
    v_display_round := 0;
    for v_phase in 1..(2 * v_rounds - 3) loop
      v_next_tokens := '{}'::jsonb[];
      v_round_label := case
        when v_phase = 2 * v_rounds - 3 then 'Final placement'
        when v_phase > 1 and mod(v_phase, 2) = 1 then 'Placement qualifier'
        when v_phase = 1 then case v_rounds when 4 then 'Round of 16' when 3 then 'Quarter-finals' else 'Final placement' end
        when v_phase = 2 and v_rounds = 4 then 'Quarter-finals'
        else 'Semi-finals'
      end;
      if v_phase = 1 or mod(v_phase, 2) = 0 then
        v_round := case when v_phase = 1 then 1 else v_phase / 2 + 1 end;
        v_drops := '{}'::jsonb[];
        v_next_alive := '{}'::int[];
        for v_slot in 1..(array_length(v_leaf_alive, 1) / 2) loop
          v_token := null;
          if v_leaf_alive[v_slot * 2 - 1] = 1 and v_leaf_alive[v_slot * 2] = 1 then
            v_token := jsonb_build_object('kind', 'drop', 'round', v_round, 'slot', v_slot);
          end if;
          v_drops := array_append(v_drops, v_token);
          v_next_alive := array_append(v_next_alive, greatest(v_leaf_alive[v_slot * 2 - 1], v_leaf_alive[v_slot * 2]));
        end loop;
        v_leaf_alive := v_next_alive;
        v_pair_count := case when v_phase = 1 then array_length(v_drops, 1) / 2 else array_length(v_drops, 1) end;
      else
        v_pair_count := array_length(v_tokens, 1) / 2;
      end if;

      for v_slot in 1..v_pair_count loop
        if v_phase = 1 then
          v_sources := array[v_drops[v_slot * 2 - 1], v_drops[v_slot * 2]];
        elsif mod(v_phase, 2) = 0 then
          -- Cross WB drops to the opposite branch to delay rematches.
          v_sources := array[v_tokens[v_slot], v_drops[array_length(v_drops, 1) - v_slot + 1]];
        else
          v_sources := array[v_tokens[v_slot * 2 - 1], v_tokens[v_slot * 2]];
        end if;
        if v_sources[1] is null and v_sources[2] is null then
          v_next_tokens := array_append(v_next_tokens, null::jsonb);
          continue;
        end if;

        insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot, metadata)
        values (p_tournament_id, 'PLAYOFF', 'LOSERS', v_phase, v_slot,
                jsonb_build_object('placement_graph_version', 2, 'round_label', v_round_label,
                  'placement_bye', v_sources[1] is null or v_sources[2] is null))
        returning id into v_mid;
        for v_side_index in 1..2 loop
          v_token := v_sources[v_side_index];
          if v_token is null then
            continue;
          end if;
          v_drop_side := case when v_side_index = 1 then 'HOME' else 'AWAY' end;
          if v_token->>'kind' = 'drop' then
            update public.matches
            set metadata = metadata || jsonb_build_object(
              'wb_drop_' || lower(v_drop_side) || '_round', (v_token->>'round')::int,
              'wb_drop_' || lower(v_drop_side) || '_slot', (v_token->>'slot')::int)
            where id = v_mid;
          else
            update public.matches
            set next_match_id = v_mid, next_match_side = v_drop_side
            where id = (v_token->>'id')::uuid;
          end if;
        end loop;
        v_next_tokens := array_append(v_next_tokens, jsonb_build_object('kind', 'winner', 'id', v_mid));
      end loop;
      v_display_round := v_phase;
      v_tokens := v_next_tokens;
    end loop;

    if v_n between 9 and 11 then
      -- Quarter-final BYEs depend on the actual losers' overall group ranks.
      -- Keep all four match placeholders unassigned until the pool is complete.
      update public.matches set next_match_id = null, next_match_side = null,
        metadata = metadata || jsonb_build_object('advances_to_round',2)
      where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS' and round = 1;
      update public.matches
      set metadata = (metadata - 'wb_drop_home_round' - 'wb_drop_home_slot' - 'wb_drop_away_round' - 'wb_drop_away_slot')
        || jsonb_build_object('placement_seed_by_group',true,'placement_seed_pending',true,'placement_bye',false)
      where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS' and round = 2;
    end if;

    -- Preserve explicit 5/6 and 7/8 classification games for eight entrants.
    if v_n = 8 then
      for v_slot in 2..3 loop
        insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot, metadata)
        values (p_tournament_id, 'PLAYOFF', 'LOSERS', v_display_round, v_slot,
          jsonb_build_object('placement_graph_version', 2,
            'classification', case when v_slot = 2 then 'extra_7th_place_game' else 'fifth_sixth_place_game' end,
            'is_additional_placement', v_slot = 2,
            'lb_loss_home_round', case when v_slot = 2 then 1 else 2 end,
            'lb_loss_home_slot', 1,
            'lb_loss_away_round', case when v_slot = 2 then 1 else 2 end,
            'lb_loss_away_slot', 2));
      end loop;
    end if;
  else
    perform public.ensure_losers_bracket(p_tournament_id);
  end if;

  if v_is_full_with_losers and v_n >= 3 and v_n <= 16 then
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
$function$;

revoke all on function public.seed_cross_group_winners_round1(uuid, uuid[]) from public, anon, authenticated;
