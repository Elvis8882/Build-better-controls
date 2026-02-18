do $$
begin
	if not exists (
		select 1
		from pg_constraint
		where conname = 'matches_bracket_unique'
			and conrelid = 'public.matches'::regclass
	) then
		alter table public.matches
			add constraint matches_bracket_unique
			unique nulls not distinct (tournament_id, stage, bracket_type, round, bracket_slot);
	end if;
end $$;
