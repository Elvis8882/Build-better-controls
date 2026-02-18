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

  -- 3rd place match: bracket_slot = 1, round = 1 in losers bracket (separate)
  insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
  select p_tournament_id, 'PLAYOFF', 'LOSERS', 1, 1
  where not exists (
    select 1
    from public.matches mx
    where mx.tournament_id = p_tournament_id
      and mx.stage = 'PLAYOFF'
      and mx.bracket_type = 'LOSERS'
      and mx.round = 1
      and mx.bracket_slot = 1
  );

  -- for 5–8 placement: only if bracket size >= 8
  if v_s >= 8 then
    -- create two "5-8 semis" and two placement finals
    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
    select p_tournament_id, 'PLAYOFF', 'LOSERS', payload.round, payload.bracket_slot
    from (values (1,2), (1,3), (2,1), (2,2)) as payload(round, bracket_slot)
    where not exists (
      select 1
      from public.matches mx
      where mx.tournament_id = p_tournament_id
        and mx.stage = 'PLAYOFF'
        and mx.bracket_type = 'LOSERS'
        and mx.round = payload.round
        and mx.bracket_slot = payload.bracket_slot
    );

    -- wire: (1,2)->(2,1 HOME), (1,3)->(2,1 AWAY) winners play for 5/6
    update public.matches set next_match_id = (
      select id from public.matches where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=2 and bracket_slot=1
    ), next_match_side='HOME'
    where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=1 and bracket_slot=2;

    update public.matches set next_match_id = (
      select id from public.matches where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=2 and bracket_slot=1
    ), next_match_side='AWAY'
    where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=1 and bracket_slot=3;

    -- losers of (1,2) and (1,3) should play for 7/8 (2,2) — wired by trigger logic.
  end if;

  -- Populating losers bracket participants requires capturing semifinal/quarterfinal losers.
  -- We do that via trigger logic.
end;
