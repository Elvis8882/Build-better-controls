-- Retire France and Poland without changing their ids: historical participants,
-- match results, and statistics must continue to resolve to the original teams.
alter table public.teams
	add column if not exists active boolean not null default true;

update public.teams
set active = false
where code in ('FRA', 'POL')
	and team_pool = 'INTL';

-- New countries get new ids. Copy the retired teams' current ratings so the
-- replacements are immediately usable and can subsequently be tuned by admins.
insert into public.teams (
	code,
	name,
	short_name,
	team_pool,
	primary_color,
	secondary_color,
	text_color,
	overall,
	off_def_sum,
	offense,
	defense,
	goalie,
	ovr_tier,
	active
)
select
	'HUN',
	'Hungary',
	'Hungary',
	'INTL',
	'#CD2A3E',
	'#436F4D',
	'#FFFFFF',
	overall,
	off_def_sum,
	offense,
	defense,
	goalie,
	ovr_tier,
	true
from public.teams
where code = 'FRA'
on conflict (code) do update set
	active = true;

insert into public.teams (
	code,
	name,
	short_name,
	team_pool,
	primary_color,
	secondary_color,
	text_color,
	overall,
	off_def_sum,
	offense,
	defense,
	goalie,
	ovr_tier,
	active
)
select
	'SVN',
	'Slovenia',
	'Slovenia',
	'INTL',
	'#005DA4',
	'#ED1C24',
	'#FFFFFF',
	overall,
	off_def_sum,
	offense,
	defense,
	goalie,
	ovr_tier,
	true
from public.teams
where code = 'POL'
on conflict (code) do update set
	active = true;

-- Tier calculations must ignore retired teams, otherwise adding replacements
-- changes every active team's rank and the expected pool size.
create or replace function public.recalculate_team_ovr_tiers()
returns integer
language sql
security definer
set search_path = public
as $$
	with ranked as (
		select
			id,
			team_pool,
			row_number() over (partition by team_pool order by overall desc, off_def_sum desc, name asc) as rank_by_ovr,
			count(*) over (partition by team_pool) as pool_size
		from public.teams
		where active = true
	), updated as (
		update public.teams t
		set ovr_tier = case
			when r.rank_by_ovr <= 5 then 'Top 5'
			when r.team_pool = 'INTL' and r.rank_by_ovr > r.pool_size - 5 then 'Bottom Tier'
			when r.team_pool = 'INTL' then 'Middle Tier'
			when r.rank_by_ovr > r.pool_size - 10 then 'Bottom Tier'
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

-- Enforce the picker rule at the database boundary as well as in the UI.
create or replace function public.reject_inactive_tournament_team()
returns trigger
language plpgsql
set search_path = public
as $$
begin
	if new.team_id is not null and not exists (
		select 1
		from public.teams
		where id = new.team_id
			and active = true
	) then
		raise exception 'Inactive teams cannot be assigned to tournament participants';
	end if;
	return new;
end;
$$;

drop trigger if exists tournament_participants_reject_inactive_team on public.tournament_participants;
create trigger tournament_participants_reject_inactive_team
before insert or update of team_id on public.tournament_participants
for each row execute function public.reject_inactive_tournament_team();
