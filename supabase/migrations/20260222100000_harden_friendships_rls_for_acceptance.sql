-- Ensure friend request receivers can create reciprocal friendship rows safely,
-- including conflict paths triggered by upsert.
do $$
begin
	if exists (select 1 from pg_policies where schemaname='public' and tablename='friendships' and policyname='friendships_insert_own') then
		drop policy friendships_insert_own on public.friendships;
	end if;

	if exists (select 1 from pg_policies where schemaname='public' and tablename='friendships' and policyname='friendships_insert_related') then
		drop policy friendships_insert_related on public.friendships;
	end if;

	create policy friendships_insert_related on public.friendships
	for insert to authenticated
	with check (user_id = auth.uid() or friend_id = auth.uid());

	if exists (select 1 from pg_policies where schemaname='public' and tablename='friendships' and policyname='friendships_update_related') then
		drop policy friendships_update_related on public.friendships;
	end if;

	create policy friendships_update_related on public.friendships
	for update to authenticated
	using (user_id = auth.uid() or friend_id = auth.uid())
	with check (user_id = auth.uid() or friend_id = auth.uid());
end $$;
