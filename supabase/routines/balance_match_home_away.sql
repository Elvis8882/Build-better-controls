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
