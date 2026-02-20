-- Execute friend-request acceptance inside a SECURITY DEFINER function so
-- reciprocal friendship rows can be inserted safely regardless client-side RLS quirks.
create or replace function public.accept_friend_request(p_request_id uuid, p_receiver_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
	v_request public.friend_requests%rowtype;
begin
	if auth.uid() is null then
		raise exception 'Not authenticated';
	end if;

	if auth.uid() <> p_receiver_id then
		raise exception 'Receiver mismatch';
	end if;

	select *
	into v_request
	from public.friend_requests
	where id = p_request_id
		and receiver_id = p_receiver_id;

	if not found then
		raise exception 'Friend request not found';
	end if;

	if v_request.status = 'rejected' then
		raise exception 'Friend request was already rejected';
	end if;

	insert into public.friendships (user_id, friend_id)
	values
		(v_request.sender_id, v_request.receiver_id),
		(v_request.receiver_id, v_request.sender_id)
	on conflict (user_id, friend_id) do nothing;

	if v_request.status = 'accepted' then
		return;
	end if;

	update public.friend_requests
	set status = 'accepted', responded_at = now()
	where id = p_request_id
		and receiver_id = p_receiver_id;
end;
$$;

grant execute on function public.accept_friend_request(uuid, uuid) to authenticated;
