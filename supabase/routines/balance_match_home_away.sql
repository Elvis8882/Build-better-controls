declare
  m record;
  v_has_group boolean;
  v_home_seed int;
  v_away_seed int;
  v_home_diff int;
  v_away_diff int;
  v_new_home uuid;
  v_new_away uuid;
begin
  select *
  into m
  from public.matches
  where id = p_match_id;

  if m.id is null or m.home_participant_id is null or m.away_participant_id is null then
    return;
  end if;

  v_new_home := m.home_participant_id;
  v_new_away := m.away_participant_id;

  select exists (
    select 1
    from public.tournament_groups tg
    where tg.tournament_id = m.tournament_id
  ) into v_has_group;

  if v_has_group then
    select seed into v_home_seed
    from public.v_playoff_seeds
    where tournament_id = m.tournament_id
      and participant_id = m.home_participant_id;

    select seed into v_away_seed
    from public.v_playoff_seeds
    where tournament_id = m.tournament_id
      and participant_id = m.away_participant_id;

    if v_home_seed is not null and v_away_seed is not null and v_away_seed < v_home_seed then
      v_new_home := m.away_participant_id;
      v_new_away := m.home_participant_id;
    end if;
  else
    select
      coalesce(sum(case when pm.home_participant_id = m.home_participant_id then 1 else 0 end), 0)
      - coalesce(sum(case when pm.away_participant_id = m.home_participant_id then 1 else 0 end), 0)
    into v_home_diff
    from public.matches pm
    where pm.tournament_id = m.tournament_id
      and pm.id <> m.id;

    select
      coalesce(sum(case when pm.home_participant_id = m.away_participant_id then 1 else 0 end), 0)
      - coalesce(sum(case when pm.away_participant_id = m.away_participant_id then 1 else 0 end), 0)
    into v_away_diff
    from public.matches pm
    where pm.tournament_id = m.tournament_id
      and pm.id <> m.id;

    if v_home_diff > v_away_diff then
      v_new_home := m.away_participant_id;
      v_new_away := m.home_participant_id;
    end if;
  end if;

  if v_new_home <> m.home_participant_id or v_new_away <> m.away_participant_id then
    update public.matches
    set home_participant_id = v_new_home,
        away_participant_id = v_new_away
    where id = m.id;

    perform public.sync_match_identities_from_participants(m.id);
  end if;
end;
