-- Allow the accepter of a friend request to upsert both directional friendship rows.
do $$
begin
	if exists (select 1 from pg_policies where schemaname='public' and tablename='friendships' and policyname='friendships_insert_own') then
		drop policy friendships_insert_own on public.friendships;
	end if;

	if not exists (select 1 from pg_policies where schemaname='public' and tablename='friendships' and policyname='friendships_insert_related') then
		create policy friendships_insert_related on public.friendships
		for insert to authenticated
		with check (user_id = auth.uid() or friend_id = auth.uid());
	end if;
end $$;
