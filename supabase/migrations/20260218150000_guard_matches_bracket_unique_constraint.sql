do $$
declare
	duplicate_count bigint;
begin
	if exists (
		select 1
		from pg_constraint
		where conname = 'matches_bracket_unique'
			and conrelid = 'public.matches'::regclass
	) then
		return;
	end if;

	select count(*)
	into duplicate_count
	from (
		select tournament_id, stage, bracket_type, round, bracket_slot
		from public.matches
		group by tournament_id, stage, bracket_type, round, bracket_slot
		having count(*) > 1
	) duplicates;

	if duplicate_count > 0 then
		raise notice
			'Skipping matches_bracket_unique creation because % duplicate key set(s) already exist in public.matches.',
			duplicate_count;
		return;
	end if;

	alter table public.matches
		add constraint matches_bracket_unique
		unique nulls not distinct (tournament_id, stage, bracket_type, round, bracket_slot);
end $$;
