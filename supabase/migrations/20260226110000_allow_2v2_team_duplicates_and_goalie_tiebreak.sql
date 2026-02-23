-- Allow 2v2 tournaments to assign two participants to the same team
-- and include goalie as the third OVR tiebreaker.

alter table public.tournament_participants
	drop constraint if exists tournament_participants_team_unique;

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
			row_number() over (
				partition by team_pool
				order by overall desc, off_def_sum desc, goalie desc, name asc
			) as rank_by_ovr,
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

drop trigger if exists teams_recalculate_ovr_tiers on public.teams;

create trigger teams_recalculate_ovr_tiers
after insert or update of overall, off_def_sum, goalie on public.teams
for each statement execute function public.trg_teams_recalculate_ovr_tiers();

select public.recalculate_team_ovr_tiers();
