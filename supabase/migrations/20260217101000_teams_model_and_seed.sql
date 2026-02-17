create table if not exists public.teams (
	id uuid primary key default gen_random_uuid(),
	code text not null unique,
	name text not null,
	short_name text not null,
	team_pool text not null,
	primary_color text not null,
	secondary_color text,
	text_color text not null,
	overall integer not null default 0,
	offense integer not null default 0,
	defense integer not null default 0,
	goalie integer not null default 0,
	created_at timestamptz not null default now(),
	constraint teams_team_pool_check check (team_pool in ('NHL', 'INTL')),
	constraint teams_primary_color_check check (primary_color ~* '^#[0-9A-F]{6}$'),
	constraint teams_secondary_color_check check (secondary_color is null or secondary_color ~* '^#[0-9A-F]{6}$'),
	constraint teams_text_color_check check (text_color ~* '^#[0-9A-F]{6}$'),
	constraint teams_overall_check check (overall between 0 and 100),
	constraint teams_offense_check check (offense between 0 and 100),
	constraint teams_defense_check check (defense between 0 and 100),
	constraint teams_goalie_check check (goalie between 0 and 100)
);

alter table public.teams enable row level security;

do $$
begin
	if not exists (select 1 from pg_policies where schemaname='public' and tablename='teams' and policyname='teams_select_auth') then
		create policy teams_select_auth on public.teams for select to authenticated using (true);
	end if;
	if not exists (select 1 from pg_policies where schemaname='public' and tablename='teams' and policyname='teams_mutate_admin') then
		create policy teams_mutate_admin on public.teams for all to authenticated using (
			exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
		) with check (
			exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
		);
	end if;
end $$;

insert into public.teams (code, name, short_name, team_pool, primary_color, secondary_color, text_color, overall, offense, defense, goalie)
values
	('ANA','Anaheim Ducks','Ducks','NHL','#F47A38','#B9975B','#FFFFFF',0,0,0,0),
	('BOS','Boston Bruins','Bruins','NHL','#FFB81C','#000000','#000000',0,0,0,0),
	('BUF','Buffalo Sabres','Sabres','NHL','#003087','#FFB81C','#FFFFFF',0,0,0,0),
	('CAR','Carolina Hurricanes','Canes','NHL','#CC0000','#000000','#FFFFFF',0,0,0,0),
	('CBJ','Columbus Blue Jackets','Blue Jackets','NHL','#002654','#CE1126','#FFFFFF',0,0,0,0),
	('CGY','Calgary Flames','Flames','NHL','#C8102E','#F1BE48','#FFFFFF',0,0,0,0),
	('CHI','Chicago Blackhawks','Blackhawks','NHL','#CF0A2C','#000000','#FFFFFF',0,0,0,0),
	('COL','Colorado Avalanche','Avalanche','NHL','#6F263D','#236192','#FFFFFF',0,0,0,0),
	('DAL','Dallas Stars','Stars','NHL','#006847','#8F8F8C','#FFFFFF',0,0,0,0),
	('DET','Detroit Red Wings','Red Wings','NHL','#CE1126','#FFFFFF','#FFFFFF',0,0,0,0),
	('EDM','Edmonton Oilers','Oilers','NHL','#041E42','#FF4C00','#FFFFFF',0,0,0,0),
	('FLA','Florida Panthers','Panthers','NHL','#041E42','#C8102E','#FFFFFF',0,0,0,0),
	('LAK','Los Angeles Kings','Kings','NHL','#111111','#A2AAAD','#FFFFFF',0,0,0,0),
	('MIN','Minnesota Wild','Wild','NHL','#154734','#A6192E','#FFFFFF',0,0,0,0),
	('MTL','Montreal Canadiens','Canadiens','NHL','#AF1E2D','#001E62','#FFFFFF',0,0,0,0),
	('NJD','New Jersey Devils','Devils','NHL','#CE1126','#000000','#FFFFFF',0,0,0,0),
	('NSH','Nashville Predators','Predators','NHL','#FFB81C','#041E42','#000000',0,0,0,0),
	('NYI','New York Islanders','Islanders','NHL','#00539B','#F47D30','#FFFFFF',0,0,0,0),
	('NYR','New York Rangers','Rangers','NHL','#0038A8','#CE1126','#FFFFFF',0,0,0,0),
	('OTT','Ottawa Senators','Senators','NHL','#C52032','#C2912C','#FFFFFF',0,0,0,0),
	('PHI','Philadelphia Flyers','Flyers','NHL','#F74902','#000000','#000000',0,0,0,0),
	('PIT','Pittsburgh Penguins','Penguins','NHL','#FCB514','#000000','#000000',0,0,0,0),
	('SEA','Seattle Kraken','Kraken','NHL','#001628','#99D9D9','#FFFFFF',0,0,0,0),
	('SJS','San Jose Sharks','Sharks','NHL','#006D75','#EA7200','#FFFFFF',0,0,0,0),
	('STL','St. Louis Blues','Blues','NHL','#002F87','#FCB514','#FFFFFF',0,0,0,0),
	('TBL','Tampa Bay Lightning','Lightning','NHL','#002868','#FFFFFF','#FFFFFF',0,0,0,0),
	('TOR','Toronto Maple Leafs','Leafs','NHL','#00205B','#FFFFFF','#FFFFFF',0,0,0,0),
	('UTA','Utah Mammoth','Mammoth','NHL','#0B162A','#6CA0DC','#FFFFFF',0,0,0,0),
	('VAN','Vancouver Canucks','Canucks','NHL','#00205B','#00843D','#FFFFFF',0,0,0,0),
	('VGK','Vegas Golden Knights','Golden Knights','NHL','#B4975A','#333F42','#000000',0,0,0,0),
	('WPG','Winnipeg Jets','Jets','NHL','#041E42','#004C97','#FFFFFF',0,0,0,0),
	('WSH','Washington Capitals','Capitals','NHL','#041E42','#C8102E','#FFFFFF',0,0,0,0),
	('AUT','Austria','Austria','INTL','#ED2939','#FFFFFF','#FFFFFF',0,0,0,0),
	('CAN','Canada','Canada','INTL','#FF0000','#FFFFFF','#FFFFFF',0,0,0,0),
	('CZE','Czechia','Czechia','INTL','#11457E','#D7141A','#FFFFFF',0,0,0,0),
	('DEN','Denmark','Denmark','INTL','#C60C30','#FFFFFF','#FFFFFF',0,0,0,0),
	('FIN','Finland','Finland','INTL','#003580','#FFFFFF','#FFFFFF',0,0,0,0),
	('FRA','France','France','INTL','#0055A4','#EF4135','#FFFFFF',0,0,0,0),
	('GBR','Great Britain','GBR','INTL','#012169','#C8102E','#FFFFFF',0,0,0,0),
	('GER','Germany','Germany','INTL','#000000','#DD0000','#FFFFFF',0,0,0,0),
	('ITA','Italy','Italy','INTL','#009246','#CE2B37','#FFFFFF',0,0,0,0),
	('LAT','Latvia','Latvia','INTL','#9E3039','#FFFFFF','#FFFFFF',0,0,0,0),
	('NOR','Norway','Norway','INTL','#BA0C2F','#00205B','#FFFFFF',0,0,0,0),
	('POL','Poland','Poland','INTL','#DC143C','#FFFFFF','#FFFFFF',0,0,0,0),
	('SVK','Slovakia','Slovakia','INTL','#0B4EA2','#EE1C25','#FFFFFF',0,0,0,0),
	('SUI','Switzerland','Switzerland','INTL','#FF0000','#FFFFFF','#FFFFFF',0,0,0,0),
	('SWE','Sweden','Sweden','INTL','#006AA7','#FECC00','#FFFFFF',0,0,0,0),
	('USA','United States','USA','INTL','#3C3B6E','#B22234','#FFFFFF',0,0,0,0)
on conflict (code) do update set
	name = excluded.name,
	short_name = excluded.short_name,
	team_pool = excluded.team_pool,
	primary_color = excluded.primary_color,
	secondary_color = excluded.secondary_color,
	text_color = excluded.text_color,
	overall = excluded.overall,
	offense = excluded.offense,
	defense = excluded.defense,
	goalie = excluded.goalie;

alter table public.tournament_participants
	drop constraint if exists tournament_participants_team_unique;

alter table public.tournament_participants
	alter column team_id type uuid using (
		case
			when team_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then team_id::uuid
			else null
		end
	);

alter table public.tournament_participants
	add constraint tournament_participants_team_unique unique (tournament_id, team_id);

do $$
begin
	if not exists (select 1 from pg_constraint where conname = 'tournament_participants_team_id_fkey') then
		alter table public.tournament_participants
			add constraint tournament_participants_team_id_fkey
			foreign key (team_id) references public.teams(id) on delete set null;
	end if;
end $$;

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
	t.code as team_code,
	t.short_name as team_short_name,
	t.primary_color as team_primary_color,
	t.secondary_color as team_secondary_color,
	t.text_color as team_text_color,
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
left join public.teams t on t.id = tp.team_id
left join public.matches m on m.tournament_id = tp.tournament_id and m.stage = 'GROUP' and (m.home_participant_id = tp.id or m.away_participant_id = tp.id)
left join public.match_results mr on mr.match_id = m.id
group by m.tournament_id, tg.id, tg.group_code, tp.id, t.code, t.short_name, t.primary_color, t.secondary_color, t.text_color;
