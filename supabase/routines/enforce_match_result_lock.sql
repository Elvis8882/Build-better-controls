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
