-- Keep duplicate team assignments allowed only for 2v2 presets.

create or replace function public.trg_tournament_participants_enforce_team_uniqueness()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
	v_preset text;
begin
	if new.team_id is null then
		return new;
	end if;

	select t.preset_id
	into v_preset
	from public.tournaments t
	where t.id = new.tournament_id;

	if coalesce(v_preset, '') not in ('2v2_tournament', '2v2_playoffs') then
		if exists (
			select 1
			from public.tournament_participants tp
			where tp.tournament_id = new.tournament_id
				and tp.team_id = new.team_id
				and tp.id <> new.id
		) then
			raise exception 'duplicate key value violates unique constraint "tournament_participants_team_unique"'
				using errcode = '23505';
		end if;
	end if;

	return new;
end;
$$;

drop trigger if exists tournament_participants_enforce_team_uniqueness on public.tournament_participants;

create trigger tournament_participants_enforce_team_uniqueness
before insert or update of tournament_id, team_id on public.tournament_participants
for each row execute function public.trg_tournament_participants_enforce_team_uniqueness();
