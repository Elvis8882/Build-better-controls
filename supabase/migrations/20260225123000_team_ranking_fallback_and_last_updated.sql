alter table public.teams
	add column if not exists off_def_sum integer not null default 0,
	add column if not exists last_updated timestamptz not null default now();

alter table public.teams
	drop constraint if exists teams_off_def_sum_check,
	add constraint teams_off_def_sum_check check (off_def_sum between 0 and 200);

update public.teams
set
	off_def_sum = offense + defense,
	last_updated = coalesce(last_updated, now())
where off_def_sum is distinct from offense + defense
	or last_updated is null;

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

create or replace function public.trg_teams_touch_last_updated_on_rating_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
	if (
		new.offense is distinct from old.offense
		or new.defense is distinct from old.defense
		or new.goalie is distinct from old.goalie
		or new.overall is distinct from old.overall
		or new.off_def_sum is distinct from old.off_def_sum
	) then
		new.last_updated := now();
	end if;
	return new;
end;
$$;

drop trigger if exists teams_touch_last_updated_on_rating_change on public.teams;

create trigger teams_touch_last_updated_on_rating_change
before update on public.teams
for each row execute function public.trg_teams_touch_last_updated_on_rating_change();

drop trigger if exists teams_recalculate_ovr_tiers on public.teams;

create trigger teams_recalculate_ovr_tiers
after insert or update of overall, off_def_sum on public.teams
for each statement execute function public.trg_teams_recalculate_ovr_tiers();

select public.recalculate_team_ovr_tiers();
