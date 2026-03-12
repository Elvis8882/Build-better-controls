declare
  v_changed boolean := true;
  r record;
  v_advancer uuid;
begin
  while v_changed loop
    v_changed := false;

    for r in
      select id, home_participant_id, away_participant_id, next_match_id, next_match_side
      from public.matches
      where tournament_id = p_tournament_id
        and stage = 'PLAYOFF'
      order by case bracket_type when 'WINNERS' then 1 else 2 end, round asc, bracket_slot asc
    loop
      if r.next_match_id is null or r.next_match_side is null then
        continue;
      end if;

      v_advancer := null;
      if r.home_participant_id is not null and r.away_participant_id is null then
        v_advancer := r.home_participant_id;
      elsif r.away_participant_id is not null and r.home_participant_id is null then
        v_advancer := r.away_participant_id;
      end if;

      if v_advancer is null then
        continue;
      end if;

      if r.next_match_side = 'HOME' then
        update public.matches
        set home_participant_id = coalesce(home_participant_id, v_advancer)
        where id = r.next_match_id
          and away_participant_id is distinct from v_advancer;
      else
        update public.matches
        set away_participant_id = coalesce(away_participant_id, v_advancer)
        where id = r.next_match_id
          and home_participant_id is distinct from v_advancer;
      end if;

      if found then
        perform public.sync_match_identities_from_participants(r.next_match_id);
        perform public.balance_match_home_away(r.next_match_id);
        v_changed := true;
      end if;
    end loop;
  end loop;
end;
