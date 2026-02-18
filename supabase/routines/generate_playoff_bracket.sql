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
