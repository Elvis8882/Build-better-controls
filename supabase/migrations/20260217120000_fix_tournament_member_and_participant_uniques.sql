alter table public.tournament_participants
	drop constraint if exists tournament_participants_user_unique,
	drop constraint if exists tournament_participants_guest_unique;

create unique index if not exists tournament_participants_user_unique
	on public.tournament_participants (tournament_id, user_id)
	where user_id is not null;

create unique index if not exists tournament_participants_guest_unique
	on public.tournament_participants (tournament_id, guest_id)
	where guest_id is not null;

alter table public.tournament_members
	drop constraint if exists tournament_members_pkey;

alter table public.tournament_members
	add constraint tournament_members_pkey primary key (tournament_id, user_id);
