alter table public.profiles
	add column if not exists bio text,
	add column if not exists favorite_team text,
	add column if not exists club_preference text;

-- Ensure only profile owners can update their own player card fields.
do $$
begin
	if not exists (
		select 1
		from pg_policies
		where schemaname = 'public'
			and tablename = 'profiles'
			and policyname = 'profiles_update_own_profile'
	) then
		create policy profiles_update_own_profile
			on public.profiles
			for update
			using (id = auth.uid())
			with check (id = auth.uid());
	end if;
end
$$;
