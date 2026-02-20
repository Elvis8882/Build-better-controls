create table if not exists public.friend_requests (
	id uuid primary key default gen_random_uuid(),
	sender_id uuid not null references public.profiles(id) on delete cascade,
	receiver_id uuid not null references public.profiles(id) on delete cascade,
	status text not null default 'pending',
	created_at timestamptz not null default now(),
	responded_at timestamptz,
	constraint friend_requests_sender_receiver_different check (sender_id <> receiver_id),
	constraint friend_requests_status_check check (status in ('pending', 'accepted', 'rejected'))
);

create unique index if not exists friend_requests_unique_pair_idx
	on public.friend_requests (sender_id, receiver_id);

create table if not exists public.friendships (
	user_id uuid not null references public.profiles(id) on delete cascade,
	friend_id uuid not null references public.profiles(id) on delete cascade,
	created_at timestamptz not null default now(),
	constraint friendships_pk primary key (user_id, friend_id),
	constraint friendships_user_friend_different check (user_id <> friend_id)
);

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;

do $$
begin
	if not exists (select 1 from pg_policies where schemaname='public' and tablename='friend_requests' and policyname='friend_requests_select_own') then
		create policy friend_requests_select_own on public.friend_requests
		for select to authenticated
		using (sender_id = auth.uid() or receiver_id = auth.uid());
	end if;

	if not exists (select 1 from pg_policies where schemaname='public' and tablename='friend_requests' and policyname='friend_requests_insert_sender') then
		create policy friend_requests_insert_sender on public.friend_requests
		for insert to authenticated
		with check (sender_id = auth.uid());
	end if;

	if not exists (select 1 from pg_policies where schemaname='public' and tablename='friend_requests' and policyname='friend_requests_update_receiver') then
		create policy friend_requests_update_receiver on public.friend_requests
		for update to authenticated
		using (receiver_id = auth.uid())
		with check (receiver_id = auth.uid());
	end if;

	if not exists (select 1 from pg_policies where schemaname='public' and tablename='friendships' and policyname='friendships_select_own') then
		create policy friendships_select_own on public.friendships
		for select to authenticated
		using (user_id = auth.uid());
	end if;

	if not exists (select 1 from pg_policies where schemaname='public' and tablename='friendships' and policyname='friendships_insert_own') then
		create policy friendships_insert_own on public.friendships
		for insert to authenticated
		with check (user_id = auth.uid());
	end if;
end $$;
