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
