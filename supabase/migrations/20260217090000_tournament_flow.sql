alter table public.tournaments
	add column if not exists team_pool text not null default 'NHL',
	add column if not exists default_participants integer not null default 8,
	add column if not exists group_count integer,
	add column if not exists stage text not null default 'GROUP';

alter table public.tournaments
	drop constraint if exists tournaments_team_pool_check,
	add constraint tournaments_team_pool_check check (team_pool in ('NHL', 'INTL')),
	drop constraint if exists tournaments_default_participants_check,
	add constraint tournaments_default_participants_check check (default_participants between 2 and 24),
	drop constraint if exists tournaments_stage_check,
	add constraint tournaments_stage_check check (stage in ('GROUP', 'PLAYOFF')),
	drop constraint if exists tournaments_preset_check,
	add constraint tournaments_preset_check check (preset_id is null or preset_id in ('playoffs_only', 'full_tournament'));

alter table public.matches
	add column if not exists stage text not null default 'GROUP',
	add column if not exists bracket_type text,
	add column if not exists home_participant_id uuid,
	add column if not exists away_participant_id uuid;

alter table public.matches
	drop constraint if exists matches_stage_check,
	add constraint matches_stage_check check (stage in ('GROUP', 'PLAYOFF')),
	drop constraint if exists matches_bracket_type_check,
	add constraint matches_bracket_type_check check (bracket_type is null or bracket_type in ('WINNERS', 'LOSERS'));

create table if not exists public.tournament_participants (
	id uuid primary key default gen_random_uuid(),
	tournament_id uuid not null references public.tournaments(id) on delete cascade,
	user_id uuid references public.profiles(id) on delete set null,
	guest_id uuid references public.tournament_guests(id) on delete set null,
	display_name text not null,
	team_id text,
	locked boolean not null default false,
	locked_by uuid references public.profiles(id) on delete set null,
	locked_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint tournament_participants_identity_check check ((user_id is not null) <> (guest_id is not null)),
	constraint tournament_participants_team_unique unique (tournament_id, team_id),
	constraint tournament_participants_user_unique unique nulls not distinct (tournament_id, user_id),
	constraint tournament_participants_guest_unique unique nulls not distinct (tournament_id, guest_id)
);

create table if not exists public.tournament_groups (
	id uuid primary key default gen_random_uuid(),
	tournament_id uuid not null references public.tournaments(id) on delete cascade,
	group_code text not null,
	created_at timestamptz not null default now(),
	constraint tournament_groups_unique unique (tournament_id, group_code)
);

create table if not exists public.tournament_group_members (
	group_id uuid not null references public.tournament_groups(id) on delete cascade,
	participant_id uuid not null references public.tournament_participants(id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (group_id, participant_id)
);

alter table public.matches
	add constraint matches_home_participant_id_fkey foreign key (home_participant_id) references public.tournament_participants(id) on delete set null,
	add constraint matches_away_participant_id_fkey foreign key (away_participant_id) references public.tournament_participants(id) on delete set null;

alter table public.tournament_participants enable row level security;
alter table public.tournament_groups enable row level security;
alter table public.tournament_group_members enable row level security;

do $$
begin
	if not exists (select 1 from pg_policies where schemaname='public' and tablename='tournament_participants' and policyname='participants_select_auth') then
		create policy participants_select_auth on public.tournament_participants for select to authenticated using (true);
	end if;
	if not exists (select 1 from pg_policies where schemaname='public' and tablename='tournament_participants' and policyname='participants_mutate_host_admin') then
		create policy participants_mutate_host_admin on public.tournament_participants for all to authenticated using (
			exists (select 1 from public.tournament_members tm where tm.tournament_id = tournament_participants.tournament_id and tm.user_id = auth.uid() and tm.role in ('host','admin'))
			or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
		) with check (
			exists (select 1 from public.tournament_members tm where tm.tournament_id = tournament_participants.tournament_id and tm.user_id = auth.uid() and tm.role in ('host','admin'))
			or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
		);
	end if;
	if not exists (select 1 from pg_policies where schemaname='public' and tablename='tournament_groups' and policyname='groups_select_auth') then
		create policy groups_select_auth on public.tournament_groups for select to authenticated using (true);
	end if;
	if not exists (select 1 from pg_policies where schemaname='public' and tablename='tournament_groups' and policyname='groups_mutate_host_admin') then
		create policy groups_mutate_host_admin on public.tournament_groups for all to authenticated using (
			exists (select 1 from public.tournament_members tm where tm.tournament_id = tournament_groups.tournament_id and tm.user_id = auth.uid() and tm.role in ('host','admin'))
			or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
		) with check (
			exists (select 1 from public.tournament_members tm where tm.tournament_id = tournament_groups.tournament_id and tm.user_id = auth.uid() and tm.role in ('host','admin'))
			or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
		);
	end if;
	if not exists (select 1 from pg_policies where schemaname='public' and tablename='tournament_group_members' and policyname='group_members_select_auth') then
		create policy group_members_select_auth on public.tournament_group_members for select to authenticated using (true);
	end if;
	if not exists (select 1 from pg_policies where schemaname='public' and tablename='tournament_group_members' and policyname='group_members_mutate_host_admin') then
		create policy group_members_mutate_host_admin on public.tournament_group_members for all to authenticated using (
			exists (
				select 1 from public.tournament_groups tg
				join public.tournament_members tm on tm.tournament_id = tg.tournament_id
				where tg.id = tournament_group_members.group_id and tm.user_id = auth.uid() and tm.role in ('host','admin')
			)
			or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
		) with check (
			exists (
				select 1 from public.tournament_groups tg
				join public.tournament_members tm on tm.tournament_id = tg.tournament_id
				where tg.id = tournament_group_members.group_id and tm.user_id = auth.uid() and tm.role in ('host','admin')
			)
			or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
		);
	end if;
end $$;

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
		for p1 in
			select participant_id from public.tournament_group_members where group_id = r.id
		loop
			for p2 in
				select participant_id from public.tournament_group_members where group_id = r.id and participant_id > p1.participant_id
			loop
				insert into public.matches(tournament_id, home_participant_id, away_participant_id, round, stage)
				values (p_tournament_id, p1.participant_id, p2.participant_id, 1, 'GROUP');
			end loop;
		end loop;
	end loop;
end;
$$;

grant execute on function public.generate_group_stage(uuid) to authenticated;

create or replace view public.v_group_standings
with (security_invoker=true)
as
select
	m.tournament_id,
	tg.id as group_id,
	tg.group_code,
	tp.id as participant_id,
	tp.display_name,
	tp.team_id,
	coalesce(sum(
		case
			when mr.locked is not true then 0
			when mr.decision = 'R' and ((m.home_participant_id = tp.id and mr.home_score > mr.away_score) or (m.away_participant_id = tp.id and mr.away_score > mr.home_score)) then 3
			when mr.decision in ('OT','SO') and ((m.home_participant_id = tp.id and mr.home_score > mr.away_score) or (m.away_participant_id = tp.id and mr.away_score > mr.home_score)) then 2
			when mr.decision in ('OT','SO') and ((m.home_participant_id = tp.id and mr.home_score < mr.away_score) or (m.away_participant_id = tp.id and mr.away_score < mr.home_score)) then 1
			else 0
		end
	),0)::int as points,
	coalesce(sum(case when m.home_participant_id = tp.id then coalesce(mr.home_score,0)-coalesce(mr.away_score,0) when m.away_participant_id = tp.id then coalesce(mr.away_score,0)-coalesce(mr.home_score,0) else 0 end),0)::int as goal_diff,
	coalesce(sum(case when m.home_participant_id = tp.id then coalesce(mr.home_shots,0)-coalesce(mr.away_shots,0) when m.away_participant_id = tp.id then coalesce(mr.away_shots,0)-coalesce(mr.home_shots,0) else 0 end),0)::int as shots_diff
from public.tournament_participants tp
join public.tournament_group_members tgm on tgm.participant_id = tp.id
join public.tournament_groups tg on tg.id = tgm.group_id
left join public.matches m on m.tournament_id = tp.tournament_id and m.stage = 'GROUP' and (m.home_participant_id = tp.id or m.away_participant_id = tp.id)
left join public.match_results mr on mr.match_id = m.id
group by m.tournament_id, tg.id, tg.group_code, tp.id;

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
begin
	if exists (
		select 1 from public.matches m
		left join public.match_results mr on mr.match_id = m.id
		where m.tournament_id = p_tournament_id and m.stage = 'GROUP' and coalesce(mr.locked,false) = false
	) then
		raise exception 'All group matches must be locked before playoffs';
	end if;

	delete from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF';
	select array_agg(participant_id order by points desc, goal_diff desc, shots_diff desc) into seeded
	from public.v_group_standings where tournament_id = p_tournament_id;

	if seeded is null then
		return;
	end if;

	i := 1;
	while i <= array_length(seeded,1) loop
		if i = array_length(seeded,1) then
			insert into public.matches(tournament_id, home_participant_id, away_participant_id, stage, bracket_type, round)
			values (p_tournament_id, seeded[i], null, 'PLAYOFF', 'WINNERS', 1);
		else
			insert into public.matches(tournament_id, home_participant_id, away_participant_id, stage, bracket_type, round)
			values (p_tournament_id, seeded[i], seeded[array_length(seeded,1)-i+1], 'PLAYOFF', 'WINNERS', 1);
		end if;
		i := i + 1;
	end loop;

	for r in
		select participant_id from public.v_group_standings where tournament_id = p_tournament_id order by points asc, goal_diff asc limit greatest(2, floor(array_length(seeded,1)/2)::int)
	loop
		insert into public.matches(tournament_id, home_participant_id, away_participant_id, stage, bracket_type, round)
		values (p_tournament_id, r.participant_id, null, 'PLAYOFF', 'LOSERS', 1);
	end loop;
end;
$$;

grant execute on function public.generate_playoff_bracket(uuid) to authenticated;
