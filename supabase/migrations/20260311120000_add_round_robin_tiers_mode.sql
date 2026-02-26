alter table public.match_results
  add column if not exists home_team_id uuid references public.teams(id),
  add column if not exists away_team_id uuid references public.teams(id);

alter table public.tournaments
	drop constraint if exists tournaments_preset_check;

alter table public.tournaments
	add constraint tournaments_preset_check
	check (
		preset_id is not null
		and preset_id in (
			'playoffs_only',
			'full_with_losers',
			'full_no_losers',
			'2v2_tournament',
			'2v2_playoffs',
			'round_robin_tiers'
		)
	);

create or replace function public.generate_round_robin_tiers_stage(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant_ids uuid[];
  v_slots uuid[];
  v_working uuid[];
  v_slot_count int;
  v_round int;
  v_pair int;
  v_candidate_a uuid;
  v_candidate_b uuid;
  v_home_id uuid;
  v_away_id uuid;
  v_wave int := 1;
  v_fixture record;
  v_middle_team_ids uuid[];
  v_pick uuid;
begin
  delete from public.tournament_group_members where group_id in (select id from public.tournament_groups where tournament_id = p_tournament_id);
  delete from public.tournament_groups where tournament_id = p_tournament_id;
  delete from public.matches where tournament_id = p_tournament_id and stage = 'GROUP';

  insert into public.tournament_groups(tournament_id, group_code) values (p_tournament_id, 'A');

  select array_agg(id order by created_at asc, id asc) into v_participant_ids
  from public.tournament_participants
  where tournament_id = p_tournament_id;

  insert into public.tournament_group_members(group_id, participant_id)
  select tg.id, tp.id
  from public.tournament_groups tg
  join public.tournament_participants tp on tp.tournament_id = tg.tournament_id
  where tg.tournament_id = p_tournament_id;

  select array_agg(id) into v_middle_team_ids
  from public.teams t
  where t.team_pool = (select team_pool from public.tournaments where id = p_tournament_id)
    and t.ovr_tier = 'Middle Tier';

  if v_middle_team_ids is not null then
    foreach v_fixture in array v_participant_ids loop
      v_pick := v_middle_team_ids[1 + floor(random() * array_length(v_middle_team_ids,1))::int];
      update public.tournament_participants set team_id = v_pick where id = v_fixture;
    end loop;
  end if;

  v_slots := v_participant_ids;
  if mod(array_length(v_slots,1),2)=1 then
    v_slots := array_append(v_slots, null);
  end if;

  v_working := v_slots;
  v_slot_count := array_length(v_working,1);
  create temporary table if not exists tmp_rr_fixtures(home_id uuid, away_id uuid, ord int);
  truncate table tmp_rr_fixtures;

  for v_round in 1..(v_slot_count - 1) loop
    for v_pair in 1..(v_slot_count / 2) loop
      v_candidate_a := v_working[v_pair];
      v_candidate_b := v_working[v_slot_count - v_pair + 1];
      if v_candidate_a is null or v_candidate_b is null then
        continue;
      end if;
      if mod(v_round + v_pair, 2)=0 then
        v_home_id := v_candidate_a;
        v_away_id := v_candidate_b;
      else
        v_home_id := v_candidate_b;
        v_away_id := v_candidate_a;
      end if;
      insert into tmp_rr_fixtures(home_id, away_id, ord) values (v_home_id, v_away_id, v_round * 100 + v_pair);
    end loop;
    v_working := array[v_working[1], v_working[v_slot_count]] || v_working[2:v_slot_count-1];
  end loop;

  while exists(select 1 from tmp_rr_fixtures) loop
    create temporary table if not exists tmp_wave(home_id uuid, away_id uuid);
    truncate table tmp_wave;
    insert into tmp_wave(home_id, away_id)
    select home_id, away_id from tmp_rr_fixtures order by ord asc limit 1;
    delete from tmp_rr_fixtures where ctid in (select ctid from tmp_rr_fixtures order by ord asc limit 1);

    insert into tmp_wave(home_id, away_id)
    select f.home_id, f.away_id
    from tmp_rr_fixtures f
    where not exists (
      select 1 from tmp_wave w
      where w.home_id in (f.home_id, f.away_id) or w.away_id in (f.home_id, f.away_id)
    )
    order by ord asc
    limit 1;

    delete from tmp_rr_fixtures
    where exists (select 1 from tmp_wave w where w.home_id = tmp_rr_fixtures.home_id and w.away_id = tmp_rr_fixtures.away_id);

    insert into public.matches(tournament_id, home_participant_id, away_participant_id, home_user_id, away_user_id, home_guest_id, away_guest_id, round, stage)
    select p_tournament_id, hp.id, ap.id, hp.user_id, ap.user_id, hp.guest_id, ap.guest_id, v_wave, 'GROUP'
    from tmp_wave w
    join public.tournament_participants hp on hp.id = w.home_id
    join public.tournament_participants ap on ap.id = w.away_id;

    v_wave := v_wave + 1;
  end loop;
end;
$$;

create or replace function public.normalize_tournament_preset(p_preset text)
returns text
language plpgsql
immutable
as $$
declare
  v_preset text := nullif(trim(p_preset), '');
begin
  if v_preset is null then
    return null;
  end if;

  if v_preset in ('playoffs_only', 'full_with_losers', 'full_no_losers', '2v2_tournament', '2v2_playoffs', 'round_robin_tiers') then
    return v_preset;
  end if;

  if v_preset = 'full_tournament' then
    raise exception 'Legacy tournament preset "%" is not accepted by contract. Run migration/update writer.', v_preset;
  end if;

  raise exception 'Unknown tournament preset "%".', v_preset;
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
begin
  if tg_op = 'UPDATE' and new.locked = true and (old.locked is distinct from true) then
    select count(*), count(*) filter (where locked) into v_total, v_locked
    from public.tournament_participants
    where tournament_id = new.tournament_id;

    if v_total = v_locked then
      select preset_id into v_preset from public.tournaments where id = new.tournament_id;

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
