-- Combined runnable script from the proposed tournament/team SQL updates.
-- Safe to run on an existing environment (idempotent where practical).

-- Supersedes the following standalone migrations in this repo:
-- - 20260217120000_fix_tournament_member_and_participant_uniques.sql
-- - 20260217133000_fix_auto_generation_and_match_user_columns.sql
-- - 20260217150000_add_team_ovr_tier.sql
-- - 20260217162000_recalc_team_tiers_on_rating_change.sql

-- 1) participant/member uniqueness fixes
alter table public.tournament_participants
	drop constraint if exists tournament_participants_user_unique,
	drop constraint if exists tournament_participants_guest_unique;

create unique index if not exists tournament_participants_user_unique
	on public.tournament_participants (tournament_id, user_id)
	where user_id is not null;

create unique index if not exists tournament_participants_guest_unique
	on public.tournament_participants (tournament_id, guest_id)
	where guest_id is not null;

alter table public.tournament_members
	drop constraint if exists tournament_members_pkey;

alter table public.tournament_members
	add constraint tournament_members_pkey primary key (tournament_id, user_id);

-- 2) match user columns + generation function compatibility
alter table public.matches
	add column if not exists home_user_id uuid,
	add column if not exists away_user_id uuid,
	add column if not exists home_guest_id uuid,
	add column if not exists away_guest_id uuid;

alter table public.matches
	alter column home_user_id drop not null,
	alter column away_user_id drop not null;

alter table public.matches
	drop constraint if exists matches_home_identity_check,
	drop constraint if exists matches_away_identity_check;

create or replace function public.generate_group_stage(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
	v_group_count int;
	v_codes text[] := array['A','B','C','D'];
	v_idx int := 1;
	r record;
	p1 record;
	p2 record;
begin
	select coalesce(group_count,1) into v_group_count from public.tournaments where id = p_tournament_id;
	delete from public.tournament_group_members where group_id in (select id from public.tournament_groups where tournament_id = p_tournament_id);
	delete from public.tournament_groups where tournament_id = p_tournament_id;
	delete from public.matches where tournament_id = p_tournament_id and stage = 'GROUP';

	for v_idx in 1..v_group_count loop
		insert into public.tournament_groups(tournament_id, group_code) values (p_tournament_id, v_codes[v_idx]);
	end loop;

	v_idx := 1;
	for r in select id from public.tournament_participants where tournament_id = p_tournament_id order by random() loop
		insert into public.tournament_group_members(group_id, participant_id)
		select id, r.id from public.tournament_groups where tournament_id = p_tournament_id and group_code = v_codes[v_idx];
		v_idx := v_idx + 1;
		if v_idx > v_group_count then v_idx := 1; end if;
	end loop;

	for r in select id from public.tournament_groups where tournament_id = p_tournament_id loop
		for p1 in select participant_id from public.tournament_group_members where group_id = r.id loop
			for p2 in select participant_id from public.tournament_group_members where group_id = r.id and participant_id > p1.participant_id loop
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
				select p_tournament_id, p1.participant_id, p2.participant_id, hp.user_id, ap.user_id, hp.guest_id, ap.guest_id, 1, 'GROUP'
				from public.tournament_participants hp
				join public.tournament_participants ap on ap.id = p2.participant_id
				where hp.id = p1.participant_id;
			end loop;
		end loop;
	end loop;
end;
$$;

create or replace function public.generate_playoff_bracket(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
	r record;
	seeded uuid[];
	i int;
	seed_count int;
begin
	if exists (
		select 1 from public.matches m
		left join public.match_results mr on mr.match_id = m.id
		where m.tournament_id = p_tournament_id and m.stage = 'GROUP' and coalesce(mr.locked,false) = false
	) then
		raise exception 'All group matches must be locked before playoffs';
	end if;

	delete from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF';

	if exists (select 1 from public.matches where tournament_id = p_tournament_id and stage = 'GROUP') then
		select array_agg(participant_id order by points desc, goal_diff desc, shots_diff desc) into seeded
		from public.v_group_standings where tournament_id = p_tournament_id;
	else
		select array_agg(id order by created_at asc) into seeded
		from public.tournament_participants
		where tournament_id = p_tournament_id;
	end if;

	if seeded is null then
		return;
	end if;

	seed_count := array_length(seeded,1);
	i := 1;
	while i <= seed_count loop
		if i = seed_count then
			insert into public.matches(
				tournament_id,
				home_participant_id,
				away_participant_id,
				home_user_id,
				away_user_id,
				home_guest_id,
				away_guest_id,
				stage,
				bracket_type,
				round
			)
			select p_tournament_id, hp.id, null, hp.user_id, null, hp.guest_id, null, 'PLAYOFF', 'WINNERS', 1
			from public.tournament_participants hp
			where hp.id = seeded[i];
		else
			insert into public.matches(
				tournament_id,
				home_participant_id,
				away_participant_id,
				home_user_id,
				away_user_id,
				home_guest_id,
				away_guest_id,
				stage,
				bracket_type,
				round
			)
			select p_tournament_id, hp.id, ap.id, hp.user_id, ap.user_id, hp.guest_id, ap.guest_id, 'PLAYOFF', 'WINNERS', 1
			from public.tournament_participants hp
			join public.tournament_participants ap on ap.id = seeded[seed_count-i+1]
			where hp.id = seeded[i];
		end if;
		i := i + 1;
	end loop;

	for r in
		select participant_id from public.v_group_standings where tournament_id = p_tournament_id order by points asc, goal_diff asc limit greatest(2, floor(seed_count/2)::int)
	loop
		insert into public.matches(
			tournament_id,
			home_participant_id,
			away_participant_id,
			home_user_id,
			away_user_id,
			home_guest_id,
			away_guest_id,
			stage,
			bracket_type,
			round
		)
		select p_tournament_id, hp.id, null, hp.user_id, null, hp.guest_id, null, 'PLAYOFF', 'LOSERS', 1
		from public.tournament_participants hp
		where hp.id = r.participant_id;
	end loop;
end;
$$;

-- 3) team OVR tiers
alter table public.teams
	add column if not exists ovr_tier text;

drop function if exists public.recalculate_team_ovr_tiers();

create function public.recalculate_team_ovr_tiers()
returns integer
language sql
security definer
set search_path = public
as $$
	with ranked as (
		select
			id,
			team_pool,
			row_number() over (partition by team_pool order by overall desc, name asc) as rank_by_ovr,
			count(*) over (partition by team_pool) as pool_size
		from public.teams
	), updated as (
		update public.teams t
		set ovr_tier = case
			when r.rank_by_ovr <= 5 then 'Top 5'
			when r.rank_by_ovr > r.pool_size - 5 then 'Bottom Tier'
			when r.rank_by_ovr <= 10 then 'Top 10'
			else 'Middle Tier'
		end
		from ranked r
		where r.id = t.id
		returning 1
	)
	select count(*)::integer from updated;
$$;

select public.recalculate_team_ovr_tiers();

alter table public.teams
	alter column ovr_tier set not null;

alter table public.teams
	drop constraint if exists teams_ovr_tier_check,
	add constraint teams_ovr_tier_check check (ovr_tier in ('Top 5', 'Top 10', 'Middle Tier', 'Bottom Tier'));

create or replace function public.trg_teams_recalculate_ovr_tiers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
	perform public.recalculate_team_ovr_tiers();
	return null;
end;
$$;

drop trigger if exists teams_recalculate_ovr_tiers on public.teams;

create trigger teams_recalculate_ovr_tiers
after insert or update of overall on public.teams
for each statement execute function public.trg_teams_recalculate_ovr_tiers();
