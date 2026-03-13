create or replace function public.advance_playoff_byes(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed boolean := true;
  r record;
  v_advancer uuid;
  v_source_locked boolean;
begin
  while v_changed loop
    v_changed := false;

    for r in
      select id, bracket_type, metadata, home_participant_id, away_participant_id, next_match_id, next_match_side
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

      -- In full_with_losers mode, losers-bracket slots can be intentionally
      -- reserved for future winners-bracket drops. Do not auto-advance from
      -- those matches until the corresponding winners match is locked and the
      -- drop side is actually known.
      if r.bracket_type = 'LOSERS' then
        if r.home_participant_id is null
          and (r.metadata ? 'wb_drop_home_round')
          and (r.metadata ? 'wb_drop_home_slot') then
          select exists (
            select 1
            from public.matches wm
            join public.match_results wr on wr.match_id = wm.id
            where wm.tournament_id = p_tournament_id
              and wm.stage = 'PLAYOFF'
              and wm.bracket_type = 'WINNERS'
              and wm.round = (r.metadata->>'wb_drop_home_round')::int
              and wm.bracket_slot = (r.metadata->>'wb_drop_home_slot')::int
              and wr.locked = true
          ) into v_source_locked;

          if not coalesce(v_source_locked, false) then
            continue;
          end if;
        end if;

        if r.away_participant_id is null
          and (r.metadata ? 'wb_drop_away_round')
          and (r.metadata ? 'wb_drop_away_slot') then
          select exists (
            select 1
            from public.matches wm
            join public.match_results wr on wr.match_id = wm.id
            where wm.tournament_id = p_tournament_id
              and wm.stage = 'PLAYOFF'
              and wm.bracket_type = 'WINNERS'
              and wm.round = (r.metadata->>'wb_drop_away_round')::int
              and wm.bracket_slot = (r.metadata->>'wb_drop_away_slot')::int
              and wr.locked = true
          ) into v_source_locked;

          if not coalesce(v_source_locked, false) then
            continue;
          end if;
        end if;
      end if;

      if r.next_match_side = 'HOME' then
        update public.matches
        set home_participant_id = coalesce(home_participant_id, v_advancer)
        where id = r.next_match_id
          and home_participant_id is null
          and away_participant_id is distinct from v_advancer;
      else
        update public.matches
        set away_participant_id = coalesce(away_participant_id, v_advancer)
        where id = r.next_match_id
          and away_participant_id is null
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
$$;

grant execute on function public.advance_playoff_byes(uuid) to authenticated;
