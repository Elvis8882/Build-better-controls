create or replace function public.generate_group_stage(p_tournament_id uuid)
returns void
language plpgsql
as $$
declare
  v_group_count int;
  v_codes text[] := array['A','B','C','D'];
  v_tournament_status text;
  v_has_locked_results boolean := false;
  v_group_index int := 1;
  v_group record;
  v_participant record;
  v_slots uuid[];
  v_working uuid[];
  v_slot_count int;
  v_round int;
  v_pair int;
  v_home_id uuid;
  v_away_id uuid;
  v_candidate_home uuid;
  v_candidate_away uuid;
  v_diff_home int;
  v_diff_away int;
  v_score_a int;
  v_score_b int;
  v_team_based boolean := false;
begin
  select t.status, coalesce(t.group_count,1), (t.preset_id in ('2v2_tournament','2v2_playoffs'))
  into v_tournament_status, v_group_count, v_team_based
  from public.tournaments t
  where t.id = p_tournament_id;

  if v_tournament_status is null then
    raise exception 'Tournament % not found', p_tournament_id;
  end if;

  if lower(v_tournament_status) = 'closed' then
    raise exception 'Cannot regenerate group stage for closed tournament';
  end if;

  select exists (
    select 1
    from public.match_results mr
    join public.matches m on m.id = mr.match_id
    where m.tournament_id = p_tournament_id
      and mr.locked = true
  )
  into v_has_locked_results;

  if v_has_locked_results then
    raise exception 'Cannot regenerate group stage after match results are locked';
  end if;

  delete from public.tournament_group_members where group_id in (select id from public.tournament_groups where tournament_id = p_tournament_id);
  delete from public.tournament_groups where tournament_id = p_tournament_id;
  delete from public.matches where tournament_id = p_tournament_id and stage = 'GROUP';

  for v_group_index in 1..v_group_count loop
    insert into public.tournament_groups(tournament_id, group_code)
    values (p_tournament_id, v_codes[v_group_index]);
  end loop;

  v_group_index := 1;
  for v_participant in
    with seeded_participants as (
      select tp.id, tp.created_at
      from public.tournament_participants tp
      where tp.tournament_id = p_tournament_id
        and (
          not v_team_based
          or tp.id in (
            select distinct on (p.team_id) p.id
            from public.tournament_participants p
            where p.tournament_id = p_tournament_id
              and p.team_id is not null
            order by p.team_id, p.created_at asc, p.id asc
          )
        )
    )
    select id
    from seeded_participants
    order by created_at asc, id asc
  loop
    insert into public.tournament_group_members(group_id, participant_id)
    select id, v_participant.id
    from public.tournament_groups
    where tournament_id = p_tournament_id and group_code = v_codes[v_group_index];

    v_group_index := v_group_index + 1;
    if v_group_index > v_group_count then
      v_group_index := 1;
    end if;
  end loop;

  for v_group in
    select id
    from public.tournament_groups
    where tournament_id = p_tournament_id
    order by group_code asc
  loop
    select array_agg(participant_id order by participant_id)
    into v_slots
    from public.tournament_group_members
    where group_id = v_group.id;

    if v_slots is null or array_length(v_slots, 1) < 2 then
      continue;
    end if;

    if mod(array_length(v_slots, 1), 2) = 1 then
      v_slots := array_append(v_slots, null);
    end if;

    v_working := v_slots;
    v_slot_count := array_length(v_working, 1);

    create temporary table if not exists tmp_group_home_away_balance(
      participant_id uuid primary key,
      home_count int not null default 0,
      away_count int not null default 0
    ) on commit drop;

    truncate table tmp_group_home_away_balance;
    insert into tmp_group_home_away_balance(participant_id)
    select pid
    from unnest(v_slots) as u(pid)
    where pid is not null;

    for v_round in 1..(v_slot_count - 1) loop
      for v_pair in 1..(v_slot_count / 2) loop
        if mod(v_round + v_pair, 2) = 0 then
          v_candidate_home := v_working[v_pair];
          v_candidate_away := v_working[v_slot_count - v_pair + 1];
        else
          v_candidate_home := v_working[v_slot_count - v_pair + 1];
          v_candidate_away := v_working[v_pair];
        end if;

        v_home_id := v_candidate_home;
        v_away_id := v_candidate_away;

        if v_home_id is not null and v_away_id is not null then
          select coalesce(home_count - away_count, 0) into v_diff_home
          from tmp_group_home_away_balance
          where participant_id = v_home_id;

          select coalesce(home_count - away_count, 0) into v_diff_away
          from tmp_group_home_away_balance
          where participant_id = v_away_id;

          v_score_a := abs(v_diff_home + 1) + abs(v_diff_away - 1);
          v_score_b := abs(v_diff_home - 1) + abs(v_diff_away + 1);

          if v_score_b < v_score_a then
            v_home_id := v_candidate_away;
            v_away_id := v_candidate_home;
          end if;
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
            p_tournament_id,
            hp.id,
            ap.id,
            hp.user_id,
            ap.user_id,
            hp.guest_id,
            ap.guest_id,
            v_round,
            'GROUP'
          from public.tournament_participants hp
          join public.tournament_participants ap on ap.id = v_away_id
          where hp.id = v_home_id;

          update tmp_group_home_away_balance
          set home_count = home_count + 1
          where participant_id = v_home_id;

          update tmp_group_home_away_balance
          set away_count = away_count + 1
          where participant_id = v_away_id;
        end if;
      end loop;

      v_working := array[v_working[1], v_working[v_slot_count]] || v_working[2:v_slot_count - 1];
    end loop;
  end loop;
end;
$$;

create or replace function public.trg_on_participants_lock_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
  v_locked int;
  v_preset text;
  v_team_entrants int;
  v_tournament_status text;
begin
  if tg_op = 'UPDATE' and new.locked = true and (old.locked is distinct from true) then
    select count(*), count(*) filter (where locked) into v_total, v_locked
    from public.tournament_participants
    where tournament_id = new.tournament_id;

    if v_total = v_locked then
      select preset_id, status into v_preset, v_tournament_status from public.tournaments where id = new.tournament_id;

      if lower(coalesce(v_tournament_status, '')) = 'closed' then
        return new;
      end if;

      if v_preset in ('2v2_tournament', '2v2_playoffs') then
        select count(*) into v_team_entrants
        from (
          select tp.team_id
          from public.tournament_participants tp
          where tp.tournament_id = new.tournament_id
            and tp.team_id is not null
          group by tp.team_id
          having count(*) >= 2
        ) entrants;

        if v_team_entrants < 3 then
          return new;
        end if;
      elsif v_preset = 'round_robin_tiers' then
        if v_total < 4 then
          return new;
        end if;
      elsif v_total < 3 then
        return new;
      end if;

      if v_preset in ('full_with_losers','full_no_losers','2v2_tournament') then
        perform public.generate_group_stage(new.tournament_id);
      elsif v_preset = 'round_robin_tiers' then
        perform public.generate_round_robin_tiers_stage(new.tournament_id);
      else
        perform public.ensure_playoff_bracket(new.tournament_id);
      end if;
    end if;
  end if;

  return new;
end;
$$;
