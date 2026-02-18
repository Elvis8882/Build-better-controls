-- Fix high-confidence drift issues between routines, app assumptions, and live schema.

-- 1) Normalize legacy preset values and enforce canonical preset domain.
update public.tournaments
set preset_id = 'full_no_losers'
where preset_id = 'full_tournament';

alter table public.tournaments
	drop constraint if exists tournaments_preset_check,
	add constraint tournaments_preset_check check (
		preset_id is not null
		and preset_id in ('playoffs_only', 'full_with_losers', 'full_no_losers')
	);

alter table public.tournaments
	alter column preset_id set default 'full_no_losers';

-- 2) Deduplicate bracket keys and enforce uniqueness constraint used by routines.
do $$
declare
	v_removed bigint := 0;
begin
	with ranked as (
		select
			ctid,
			row_number() over (
				partition by tournament_id, stage, bracket_type, round, bracket_slot
				order by created_at asc, id asc
			) as rn
		from public.matches
	), removed as (
		delete from public.matches m
		using ranked r
		where m.ctid = r.ctid
			and r.rn > 1
		returning 1
	)
	select count(*) into v_removed from removed;

	raise notice 'Removed % duplicate bracket-key matches rows before adding unique constraint.', v_removed;

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

-- 3) Install current routine versions as executable DB functions.
create or replace function public.sync_match_identities_from_participants(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
	m record;
	hp record;
	ap record;
begin
	select * into m from public.matches where id = p_match_id;

	if m.home_participant_id is not null then
		select user_id, guest_id into hp
		from public.tournament_participants
		where id = m.home_participant_id;
	end if;

	if m.away_participant_id is not null then
		select user_id, guest_id into ap
		from public.tournament_participants
		where id = m.away_participant_id;
	end if;

	update public.matches
	set
		home_user_id = hp.user_id,
		home_guest_id = hp.guest_id,
		away_user_id = ap.user_id,
		away_guest_id = ap.guest_id
	where id = p_match_id;
end;
$$;

create or replace function public.generate_group_stage(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
	v_group_count int;
	v_codes text[] := array['A','B','C','D'];
	v_group_index int := 1;
	v_group record;
	v_participant record;
	v_slots uuid[];
	v_working uuid[];
	v_slot_count int;
	v_round int;
	v_pair int;
	v_home_id uuid;
	v_away_id uuid;
begin
	select coalesce(group_count,1) into v_group_count from public.tournaments where id = p_tournament_id;

	delete from public.tournament_group_members where group_id in (select id from public.tournament_groups where tournament_id = p_tournament_id);
	delete from public.tournament_groups where tournament_id = p_tournament_id;
	delete from public.matches where tournament_id = p_tournament_id and stage = 'GROUP';

	for v_group_index in 1..v_group_count loop
		insert into public.tournament_groups(tournament_id, group_code)
		values (p_tournament_id, v_codes[v_group_index]);
	end loop;

	v_group_index := 1;
	for v_participant in
		select id
		from public.tournament_participants
		where tournament_id = p_tournament_id
		order by created_at asc, id asc
	loop
		insert into public.tournament_group_members(group_id, participant_id)
		select id, v_participant.id
		from public.tournament_groups
		where tournament_id = p_tournament_id and group_code = v_codes[v_group_index];

		v_group_index := v_group_index + 1;
		if v_group_index > v_group_count then
			v_group_index := 1;
		end if;
	end loop;

	for v_group in
		select id
		from public.tournament_groups
		where tournament_id = p_tournament_id
		order by group_code asc
	loop
		select array_agg(participant_id order by participant_id)
		into v_slots
		from public.tournament_group_members
		where group_id = v_group.id;

		if v_slots is null or array_length(v_slots, 1) < 2 then
			continue;
		end if;

		if mod(array_length(v_slots, 1), 2) = 1 then
			v_slots := array_append(v_slots, null);
		end if;

		v_working := v_slots;
		v_slot_count := array_length(v_working, 1);

		for v_round in 1..(v_slot_count - 1) loop
			for v_pair in 1..(v_slot_count / 2) loop
				if mod(v_round + v_pair, 2) = 0 then
					v_home_id := v_working[v_pair];
					v_away_id := v_working[v_slot_count - v_pair + 1];
				else
					v_home_id := v_working[v_slot_count - v_pair + 1];
					v_away_id := v_working[v_pair];
				end if;

				if v_home_id is not null and v_away_id is not null then
					insert into public.matches(
						tournament_id,
						home_participant_id,
						away_participant_id,
						home_user_id,
						away_user_id,
						home_guest_id,
						away_guest_id,
						round,
						stage
					)
					select
						p_tournament_id,
						hp.id,
						ap.id,
						hp.user_id,
						ap.user_id,
						hp.guest_id,
						ap.guest_id,
						v_round,
						'GROUP'
					from public.tournament_participants hp
					join public.tournament_participants ap on ap.id = v_away_id
					where hp.id = v_home_id;
				end if;
			end loop;

			v_working := array[v_working[1], v_working[v_slot_count]] || v_working[2:v_slot_count - 1];
		end loop;
	end loop;
end;
$$;

create or replace function public.generate_playoff_bracket(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
	r record;
	seeded uuid[];
	i int;
	seed_count int;
	pair_count int;
begin
	if exists (
		select 1 from public.matches m
		left join public.match_results mr on mr.match_id = m.id
		where m.tournament_id = p_tournament_id and m.stage = 'GROUP' and coalesce(mr.locked,false) = false
	) then
		raise exception 'All group matches must be locked before playoffs';
	end if;

	delete from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF';

	if exists (select 1 from public.matches where tournament_id = p_tournament_id and stage = 'GROUP') then
		select array_agg(participant_id order by points desc, goal_diff desc, shots_diff desc) into seeded
		from public.v_group_standings where tournament_id = p_tournament_id;
	else
		select array_agg(id order by created_at asc) into seeded
		from public.tournament_participants
		where tournament_id = p_tournament_id;
	end if;

	if seeded is null then
		return;
	end if;

	seed_count := array_length(seeded,1);
	pair_count := ceil(seed_count / 2.0);
	i := 1;
	while i <= pair_count loop
		if i = seed_count - i + 1 then
			insert into public.matches(
				tournament_id,
				home_participant_id,
				away_participant_id,
				home_user_id,
				away_user_id,
				home_guest_id,
				away_guest_id,
				stage,
				bracket_type,
				round
			)
			select p_tournament_id, hp.id, null, hp.user_id, null, hp.guest_id, null, 'PLAYOFF', 'WINNERS', 1
			from public.tournament_participants hp
			where hp.id = seeded[i];
		else
			insert into public.matches(
				tournament_id,
				home_participant_id,
				away_participant_id,
				home_user_id,
				away_user_id,
				home_guest_id,
				away_guest_id,
				stage,
				bracket_type,
				round
			)
			select p_tournament_id, hp.id, ap.id, hp.user_id, ap.user_id, hp.guest_id, ap.guest_id, 'PLAYOFF', 'WINNERS', 1
			from public.tournament_participants hp
			join public.tournament_participants ap on ap.id = seeded[seed_count-i+1]
			where hp.id = seeded[i];
		end if;
		i := i + 1;
	end loop;

	if exists (select 1 from public.matches where tournament_id = p_tournament_id and stage = 'GROUP') then
		for r in
			select participant_id
			from public.v_group_standings
			where tournament_id = p_tournament_id
			order by points asc, goal_diff asc
			limit greatest(2, floor(seed_count/2)::int)
		loop
			insert into public.matches(
				tournament_id,
				home_participant_id,
				away_participant_id,
				home_user_id,
				away_user_id,
				home_guest_id,
				away_guest_id,
				stage,
				bracket_type,
				round
			)
			select p_tournament_id, hp.id, null, hp.user_id, null, hp.guest_id, null, 'PLAYOFF', 'LOSERS', 1
			from public.tournament_participants hp
			where hp.id = r.participant_id;
		end loop;
	end if;
end;
$$;

create or replace function public.ensure_playoff_bracket(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
	r record;
	v_n int;
	v_s int;
	v_rounds int;
	v_round int;
	v_slot int;
	v_matches_in_round int;
	v_seeded uuid[];
	v_has_group boolean;
	v_any_playoff_locked boolean;
	v_mid uuid;
	v_parent uuid;
	v_parent_side text;
	v_home uuid;
	v_away uuid;
	v_seed_count int;
begin
	select exists (
		select 1
		from public.matches m
		join public.match_results mr on mr.match_id = m.id
		where m.tournament_id = p_tournament_id
			and m.stage = 'PLAYOFF'
			and mr.locked = true
	) into v_any_playoff_locked;

	select count(*) into v_n
	from public.tournament_participants
	where tournament_id = p_tournament_id;

	if v_n < 3 then
		return;
	end if;

	v_s := 1;
	while v_s < v_n loop v_s := v_s * 2; end loop;
	v_rounds := (log(v_s)::numeric / log(2)::numeric)::int;

	for v_round in 1..v_rounds loop
		v_matches_in_round := v_s / (2^v_round);
		for v_slot in 1..v_matches_in_round loop
			insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
			select p_tournament_id, 'PLAYOFF', 'WINNERS', v_round, v_slot
			where not exists (
				select 1
				from public.matches mx
				where mx.tournament_id = p_tournament_id
					and mx.stage = 'PLAYOFF'
					and mx.bracket_type = 'WINNERS'
					and mx.round = v_round
					and mx.bracket_slot = v_slot
			);
		end loop;
	end loop;

	for v_round in 1..(v_rounds - 1) loop
		v_matches_in_round := v_s / (2^v_round);
		for v_slot in 1..v_matches_in_round loop
			select id into v_mid
			from public.matches
			where tournament_id = p_tournament_id
				and stage = 'PLAYOFF' and bracket_type = 'WINNERS'
				and round = v_round and bracket_slot = v_slot;

			select id into v_parent
			from public.matches
			where tournament_id = p_tournament_id
				and stage = 'PLAYOFF' and bracket_type = 'WINNERS'
				and round = (v_round + 1) and bracket_slot = ceil(v_slot/2.0)::int;

			v_parent_side := case when (v_slot % 2) = 1 then 'HOME' else 'AWAY' end;

			update public.matches
			set next_match_id = v_parent,
				next_match_side = v_parent_side
			where id = v_mid;
		end loop;
	end loop;

	if v_any_playoff_locked then
		return;
	end if;

	select exists (
		select 1
		from public.tournament_groups
		where tournament_id = p_tournament_id
	) into v_has_group;

	if v_has_group then
		select array_agg(participant_id order by seed asc) into v_seeded
		from public.v_playoff_seeds
		where tournament_id = p_tournament_id;
	else
		if not exists (select 1 from public.tournament_playoff_seeds where tournament_id = p_tournament_id) then
			insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
			select p_tournament_id,
				row_number() over (order by random())::int as seed,
				id
			from public.tournament_participants
			where tournament_id = p_tournament_id;
		end if;

		-- heal stale or mismatched seed rows
		select count(*) into v_seed_count
		from public.tournament_playoff_seeds
		where tournament_id = p_tournament_id;

		if v_seed_count <> v_n
			or exists (
				select 1
				from public.tournament_playoff_seeds s
				left join public.tournament_participants tp on tp.id = s.participant_id and tp.tournament_id = p_tournament_id
				where s.tournament_id = p_tournament_id
					and tp.id is null
			)
		then
			delete from public.tournament_playoff_seeds where tournament_id = p_tournament_id;
			insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
			select p_tournament_id,
				row_number() over (order by random())::int as seed,
				id
			from public.tournament_participants
			where tournament_id = p_tournament_id;
		end if;

		select array_agg(participant_id order by seed asc) into v_seeded
		from public.tournament_playoff_seeds
		where tournament_id = p_tournament_id;
	end if;

	if v_seeded is null then
		return;
	end if;

	v_matches_in_round := v_s / 2;
	for v_slot in 1..v_matches_in_round loop
		v_home := case when v_slot <= v_n then v_seeded[v_slot] else null end;
		v_away := case when (v_s - v_slot + 1) <= v_n then v_seeded[v_s - v_slot + 1] else null end;

		update public.matches
		set home_participant_id = v_home,
			away_participant_id = v_away
		where tournament_id = p_tournament_id
			and stage = 'PLAYOFF' and bracket_type = 'WINNERS'
			and round = 1 and bracket_slot = v_slot;

		select id into v_mid
		from public.matches
		where tournament_id = p_tournament_id
			and stage = 'PLAYOFF' and bracket_type = 'WINNERS'
			and round = 1 and bracket_slot = v_slot;

		perform public.sync_match_identities_from_participants(v_mid);
	end loop;

	update public.matches
	set home_participant_id = null,
		away_participant_id = null,
		home_user_id = null,
		away_user_id = null,
		home_guest_id = null,
		away_guest_id = null
	where tournament_id = p_tournament_id
		and stage = 'PLAYOFF' and bracket_type = 'WINNERS'
		and round > 1;

	for v_round in 1..v_rounds loop
		for v_slot in 1..(v_s / (2^v_round)) loop
			select id, home_participant_id, away_participant_id, next_match_id, next_match_side
			into r
			from public.matches
			where tournament_id = p_tournament_id
				and stage = 'PLAYOFF' and bracket_type = 'WINNERS'
				and round = v_round and bracket_slot = v_slot;

			if r.next_match_id is not null then
				if r.home_participant_id is not null and r.away_participant_id is null then
					if r.next_match_side = 'HOME' then
						update public.matches set home_participant_id = r.home_participant_id where id = r.next_match_id and home_participant_id is null;
					else
						update public.matches set away_participant_id = r.home_participant_id where id = r.next_match_id and away_participant_id is null;
					end if;
				elsif r.away_participant_id is not null and r.home_participant_id is null then
					if r.next_match_side = 'HOME' then
						update public.matches set home_participant_id = r.away_participant_id where id = r.next_match_id and home_participant_id is null;
					else
						update public.matches set away_participant_id = r.away_participant_id where id = r.next_match_id and away_participant_id is null;
					end if;
				end if;
			end if;
		end loop;
	end loop;

	for r in
		select id from public.matches
		where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'WINNERS'
	loop
		perform public.sync_match_identities_from_participants(r.id);
	end loop;
end;
$$;

create or replace function public.ensure_losers_bracket(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
	v_preset text;
	v_n int;
	v_s int;
begin
	select preset_id into v_preset from public.tournaments where id = p_tournament_id;
	if v_preset <> 'full_with_losers' then
		return;
	end if;

	select count(*) into v_n from public.tournament_participants where tournament_id = p_tournament_id;
	if v_n < 4 then
		return;
	end if;

	v_s := 1;
	while v_s < v_n loop v_s := v_s * 2; end loop;

	insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
	select p_tournament_id, 'PLAYOFF', 'LOSERS', 1, 1
	where not exists (
		select 1 from public.matches
		where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS' and round = 1 and bracket_slot = 1
	);

	if v_s >= 8 then
		insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
		select p_tournament_id, 'PLAYOFF', 'LOSERS', payload.round, payload.bracket_slot
		from (values (1,2), (1,3), (2,1), (2,2)) as payload(round, bracket_slot)
		where not exists (
			select 1 from public.matches mx
			where mx.tournament_id = p_tournament_id
				and mx.stage = 'PLAYOFF'
				and mx.bracket_type = 'LOSERS'
				and mx.round = payload.round
				and mx.bracket_slot = payload.bracket_slot
		);

		update public.matches set next_match_id = (
			select id from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS' and round = 2 and bracket_slot = 1
		), next_match_side = 'HOME'
		where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS' and round = 1 and bracket_slot = 2;

		update public.matches set next_match_id = (
			select id from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS' and round = 2 and bracket_slot = 1
		), next_match_side = 'AWAY'
		where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS' and round = 1 and bracket_slot = 3;
	end if;
end;
$$;

create or replace function public.trg_advance_playoff_winner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
	m record;
	winner uuid;
begin
	if new.locked is distinct from true then
		return new;
	end if;

	select * into m from public.matches where id = new.match_id;
	if m.stage <> 'PLAYOFF' or m.bracket_type <> 'WINNERS' then
		return new;
	end if;

	if new.home_score > new.away_score then
		winner := m.home_participant_id;
	elsif new.away_score > new.home_score then
		winner := m.away_participant_id;
	else
		return new;
	end if;

	if m.next_match_id is null or m.next_match_side is null then
		return new;
	end if;

	if m.next_match_side = 'HOME' then
		update public.matches set home_participant_id = winner where id = m.next_match_id;
	else
		update public.matches set away_participant_id = winner where id = m.next_match_id;
	end if;

	perform public.sync_match_identities_from_participants(m.next_match_id);
	return new;
end;
$$;

create or replace function public.trg_on_group_result_lock_reseed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
	m record;
begin
	if new.locked is distinct from true then
		return new;
	end if;

	select * into m from public.matches where id = new.match_id;
	if m.stage <> 'GROUP' then
		return new;
	end if;

	perform public.ensure_playoff_bracket(m.tournament_id);

	if not exists (
		select 1
		from public.matches mx
		left join public.match_results mr on mr.match_id = mx.id
		where mx.tournament_id = m.tournament_id
			and mx.stage = 'GROUP'
			and coalesce(mr.locked, false) = false
	) then
		update public.tournaments set stage = 'PLAYOFF' where id = m.tournament_id;
	end if;

	return new;
end;
$$;

create or replace function public.trg_place_losers_into_losers_bracket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
	m record;
	loser uuid;
	target uuid;
begin
	if new.locked is distinct from true then
		return new;
	end if;

	select * into m from public.matches where id = new.match_id;
	if m.stage <> 'PLAYOFF' or m.bracket_type <> 'WINNERS' then
		return new;
	end if;

	if (select preset_id from public.tournaments where id = m.tournament_id) <> 'full_with_losers' then
		return new;
	end if;

	perform public.ensure_losers_bracket(m.tournament_id);

	if new.home_score > new.away_score then
		loser := m.away_participant_id;
	elsif new.away_score > new.home_score then
		loser := m.home_participant_id;
	else
		return new;
	end if;

	if m.next_match_id is not null
		and (select next_match_id from public.matches where id = m.next_match_id) is null
	then
		select id into target
		from public.matches
		where tournament_id = m.tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS'
			and round = 1 and bracket_slot = 1;

		if target is not null then
			update public.matches
			set home_participant_id = coalesce(home_participant_id, loser),
				away_participant_id = case when home_participant_id is not null and away_participant_id is null then loser else away_participant_id end
			where id = target;

			perform public.sync_match_identities_from_participants(target);
		end if;

		return new;
	end if;

	if m.next_match_id is not null then
		select id into target
		from public.matches
		where tournament_id = m.tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS'
			and round = 1 and bracket_slot = 2
			and (home_participant_id is null or away_participant_id is null)
		limit 1;

		if target is null then
			select id into target
			from public.matches
			where tournament_id = m.tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS'
				and round = 1 and bracket_slot = 3
				and (home_participant_id is null or away_participant_id is null)
			limit 1;
		end if;

		if target is not null then
			update public.matches
			set home_participant_id = coalesce(home_participant_id, loser),
				away_participant_id = case when home_participant_id is not null and away_participant_id is null then loser else away_participant_id end
			where id = target;

			perform public.sync_match_identities_from_participants(target);
		end if;
	end if;

	return new;
end;
$$;

create or replace function public.trg_on_participants_lock_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
	v_total int;
	v_locked int;
	v_preset text;
begin
	if tg_op = 'UPDATE' and new.locked = true and (old.locked is distinct from true) then
		select count(*), count(*) filter (where locked) into v_total, v_locked
		from public.tournament_participants
		where tournament_id = new.tournament_id;

		if v_total >= 3 and v_total = v_locked then
			select preset_id into v_preset from public.tournaments where id = new.tournament_id;

			if v_preset in ('full_with_losers', 'full_no_losers') then
				perform public.generate_group_stage(new.tournament_id);
			else
				perform public.ensure_playoff_bracket(new.tournament_id);
			end if;
		end if;
	end if;

	return new;
end;
$$;

create or replace function public.enforce_match_result_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
	actor_is_admin boolean;
	actor_is_host boolean;
	actor_is_participant boolean;
begin
	actor_is_admin := public.is_admin();
	actor_is_host := public.is_host_of_match(old.match_id);
	actor_is_participant := public.is_participant_of_match(old.match_id);

	if old.locked = true then
		if actor_is_admin or actor_is_host then
			return new;
		end if;
		raise exception 'Result is locked; only host/admin can change it';
	end if;

	if new.locked = true and old.locked = false then
		if not (actor_is_admin or actor_is_host or actor_is_participant) then
			raise exception 'Only match participants or host/admin can lock results';
		end if;

		new.locked_by := coalesce(new.locked_by, auth.uid());
		new.locked_at := coalesce(new.locked_at, now());
		return new;
	end if;

	return new;
end;
$$;

-- 4) Install trigger bindings for these routines.
drop trigger if exists match_results_enforce_result_lock on public.match_results;
create trigger match_results_enforce_result_lock
before update on public.match_results
for each row
execute function public.enforce_match_result_lock();

drop trigger if exists match_results_advance_playoff_winner on public.match_results;
create trigger match_results_advance_playoff_winner
after update of locked, home_score, away_score on public.match_results
for each row
execute function public.trg_advance_playoff_winner();

drop trigger if exists match_results_group_lock_reseed on public.match_results;
create trigger match_results_group_lock_reseed
after update of locked on public.match_results
for each row
execute function public.trg_on_group_result_lock_reseed();

drop trigger if exists match_results_place_losers on public.match_results;
create trigger match_results_place_losers
after update of locked, home_score, away_score on public.match_results
for each row
execute function public.trg_place_losers_into_losers_bracket();

drop trigger if exists participants_lock_check on public.tournament_participants;
create trigger participants_lock_check
after update of locked on public.tournament_participants
for each row
execute function public.trg_on_participants_lock_check();
