create or replace function public.advance_goal_difference_duel_after_lock(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match record;
  v_tournament record;
  v_participant_a record;
  v_participant_b record;
  v_target int;
  v_cumulative int := 0;
  v_latest_locked record;
  v_shift int;
  v_winner_id uuid;
  v_loser_id uuid;
  v_next_round int;
  v_home_participant_id uuid;
  v_away_participant_id uuid;
  v_team_a uuid;
  v_team_b uuid;
  v_tier_a text;
  v_tier_b text;
  v_target_tier_a text;
  v_target_tier_b text;
  v_existing_future_match_id uuid;
begin
  if p_match_id is null then
    raise exception 'match_id is required';
  end if;

  if not public.can_manage_match_result(p_match_id) then
    raise exception 'Not authorized to advance goal difference duel';
  end if;

  select
    m.id,
    m.tournament_id,
    m.round,
    m.stage,
    m.home_participant_id,
    m.away_participant_id,
    mr.locked,
    mr.home_score,
    mr.away_score
  into v_match
  from public.matches m
  join public.match_results mr on mr.match_id = m.id
  where m.id = p_match_id;

  if not found then
    raise exception 'Locked match result not found for match %', p_match_id;
  end if;

  if v_match.stage <> 'GROUP' then
    return;
  end if;

  if v_match.locked is distinct from true then
    raise exception 'Match % is not locked', p_match_id;
  end if;

  if v_match.home_score is null or v_match.away_score is null then
    raise exception 'Locked match % is missing score values', p_match_id;
  end if;

  select *
  into v_tournament
  from public.tournaments t
  where t.id = v_match.tournament_id
  for update;

  if not found then
    raise exception 'Tournament % not found', v_match.tournament_id;
  end if;

  if v_tournament.preset_id <> 'goal_difference_duel' then
    raise exception 'Tournament % is not goal_difference_duel', v_tournament.id;
  end if;

  select id, team_id, created_at
  into v_participant_a
  from public.tournament_participants tp
  where tp.tournament_id = v_tournament.id
  order by tp.created_at asc, tp.id asc
  limit 1;

  select id, team_id, created_at
  into v_participant_b
  from public.tournament_participants tp
  where tp.tournament_id = v_tournament.id
  order by tp.created_at asc, tp.id asc
  offset 1
  limit 1;

  if v_participant_a.id is null or v_participant_b.id is null then
    raise exception 'Goal difference duel requires two participants';
  end if;

  v_next_round := coalesce(v_match.round, 0) + 1;

  select m.id
  into v_existing_future_match_id
  from public.matches m
  where m.tournament_id = v_tournament.id
    and m.stage = 'GROUP'
    and m.round = v_next_round
    and (
      (m.home_participant_id = v_participant_a.id and m.away_participant_id = v_participant_b.id)
      or (m.home_participant_id = v_participant_b.id and m.away_participant_id = v_participant_a.id)
    )
  order by m.created_at asc, m.id asc
  limit 1;

  if v_existing_future_match_id is not null then
    return;
  end if;

  for v_latest_locked in
    select
      m.id,
      m.round,
      m.home_participant_id,
      m.away_participant_id,
      mr.home_score,
      mr.away_score
    from public.matches m
    join public.match_results mr on mr.match_id = m.id
    where m.tournament_id = v_tournament.id
      and m.stage = 'GROUP'
      and mr.locked = true
      and mr.home_score is not null
      and mr.away_score is not null
      and (
        (m.home_participant_id = v_participant_a.id and m.away_participant_id = v_participant_b.id)
        or (m.home_participant_id = v_participant_b.id and m.away_participant_id = v_participant_a.id)
      )
    order by m.round asc, m.created_at asc, m.id asc
  loop
    if v_latest_locked.home_participant_id = v_participant_a.id then
      v_cumulative := v_cumulative + (v_latest_locked.home_score - v_latest_locked.away_score);
    else
      v_cumulative := v_cumulative + (v_latest_locked.away_score - v_latest_locked.home_score);
    end if;

    if v_latest_locked.id = p_match_id then
      exit;
    end if;
  end loop;

  if v_latest_locked.id is distinct from p_match_id then
    raise exception 'Locked match % not part of duel history', p_match_id;
  end if;

  v_target := greatest(1, coalesce(v_tournament.group_count, 5));
  if abs(v_cumulative) >= v_target then
    return;
  end if;

  if v_latest_locked.home_score = v_latest_locked.away_score then
    return;
  end if;

  if v_latest_locked.home_score > v_latest_locked.away_score then
    v_winner_id := v_latest_locked.home_participant_id;
    v_loser_id := v_latest_locked.away_participant_id;
  else
    v_winner_id := v_latest_locked.away_participant_id;
    v_loser_id := v_latest_locked.home_participant_id;
  end if;

  v_shift := case when abs(v_latest_locked.home_score - v_latest_locked.away_score) >= 4 then 2 else 1 end;

  select t.ovr_tier into v_tier_a
  from public.teams t
  where t.id = v_participant_a.team_id;
  v_tier_a := coalesce(v_tier_a, 'Middle Tier');

  select t.ovr_tier into v_tier_b
  from public.teams t
  where t.id = v_participant_b.team_id;
  v_tier_b := coalesce(v_tier_b, 'Middle Tier');

  v_target_tier_a := (
    select tier_name
    from (
      values
        ('Top 5', 1),
        ('Top 10', 2),
        ('Middle Tier', 3),
        ('Bottom Tier', 4)
    ) as tiers(tier_name, tier_idx)
    where tier_idx = least(
      4,
      greatest(
        1,
        (select tier_idx from (values ('Top 5',1),('Top 10',2),('Middle Tier',3),('Bottom Tier',4)) as cur(name, tier_idx) where cur.name = v_tier_a)
        + case
            when v_participant_a.id = v_winner_id then v_shift
            when v_participant_a.id = v_loser_id then -v_shift
            else 0
          end
      )
    )
  );

  v_target_tier_b := (
    select tier_name
    from (
      values
        ('Top 5', 1),
        ('Top 10', 2),
        ('Middle Tier', 3),
        ('Bottom Tier', 4)
    ) as tiers(tier_name, tier_idx)
    where tier_idx = least(
      4,
      greatest(
        1,
        (select tier_idx from (values ('Top 5',1),('Top 10',2),('Middle Tier',3),('Bottom Tier',4)) as cur(name, tier_idx) where cur.name = v_tier_b)
        + case
            when v_participant_b.id = v_winner_id then v_shift
            when v_participant_b.id = v_loser_id then -v_shift
            else 0
          end
      )
    )
  );

  select t.id
  into v_team_a
  from public.teams t
  where t.team_pool = v_tournament.team_pool
    and t.ovr_tier = v_target_tier_a
    and t.id is distinct from v_participant_a.team_id
  order by random()
  limit 1;

  if v_team_a is null then
    v_team_a := v_participant_a.team_id;
  end if;

  select t.id
  into v_team_b
  from public.teams t
  where t.team_pool = v_tournament.team_pool
    and t.ovr_tier = v_target_tier_b
    and t.id is distinct from v_participant_b.team_id
    and t.id is distinct from v_team_a
  order by random()
  limit 1;

  if v_team_b is null then
    select t.id
    into v_team_b
    from public.teams t
    where t.team_pool = v_tournament.team_pool
      and t.ovr_tier = v_target_tier_b
      and t.id is distinct from v_team_a
    order by random()
    limit 1;
  end if;

  if v_team_b is null then
    v_team_b := v_participant_b.team_id;
  end if;

  update public.tournament_participants
  set team_id = case when id = v_participant_a.id then v_team_a else v_team_b end
  where id in (v_participant_a.id, v_participant_b.id)
    and team_id is distinct from case when id = v_participant_a.id then v_team_a else v_team_b end;

  v_home_participant_id := case when mod(v_next_round, 2) = 1 then v_participant_a.id else v_participant_b.id end;
  v_away_participant_id := case when mod(v_next_round, 2) = 1 then v_participant_b.id else v_participant_a.id end;

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
    v_tournament.id,
    v_home_participant_id,
    v_away_participant_id,
    hp.user_id,
    ap.user_id,
    hp.guest_id,
    ap.guest_id,
    v_next_round,
    'GROUP'
  from public.tournament_participants hp
  join public.tournament_participants ap on ap.id = v_away_participant_id
  where hp.id = v_home_participant_id
    and not exists (
      select 1
      from public.matches m
      where m.tournament_id = v_tournament.id
        and m.stage = 'GROUP'
        and m.round = v_next_round
        and (
          (m.home_participant_id = v_home_participant_id and m.away_participant_id = v_away_participant_id)
          or (m.home_participant_id = v_away_participant_id and m.away_participant_id = v_home_participant_id)
        )
    );
end;
$$;

grant execute on function public.advance_goal_difference_duel_after_lock(uuid) to authenticated;
