-- Adjust INTL OVR tiering for the 16-team pool: Top 5, Middle Tier, Bottom Tier (last 5).

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
