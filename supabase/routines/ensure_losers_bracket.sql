declare
  v_preset text;
  v_n int;
  v_s int;
  v_rounds int;
  sf_round int;
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
  v_rounds := (log(v_s)::numeric / log(2)::numeric)::int;
  sf_round := v_rounds - 1;

  -- 3rd place match: bracket_slot = 1, round = 1 in losers bracket (separate)
  insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
  values (p_tournament_id, 'PLAYOFF', 'LOSERS', 1, 1)
  on conflict on constraint matches_bracket_unique do nothing;

  -- for 5вЂ“8 placement: only if bracket size >= 8
  if v_s >= 8 then
    -- create two ""5-8 semis"" and two placement finals
    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
    values
      (p_tournament_id,'PLAYOFF','LOSERS',1,2),
      (p_tournament_id,'PLAYOFF','LOSERS',1,3),
      (p_tournament_id,'PLAYOFF','LOSERS',2,1),
      (p_tournament_id,'PLAYOFF','LOSERS',2,2)
    on conflict on constraint matches_bracket_unique do nothing;

    -- wire: (1,2)->(2,1 HOME), (1,3)->(2,1 AWAY) winners play for 5/6
    update public.matches set next_match_id = (
      select id from public.matches where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=2 and bracket_slot=1
    ), next_match_side='HOME'
    where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=1 and bracket_slot=2;

    update public.matches set next_match_id = (
      select id from public.matches where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=2 and bracket_slot=1
    ), next_match_side='AWAY'
    where tournament_id=p_tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=1 and bracket_slot=3;

    -- losers of (1,2) and (1,3) should play for 7/8 (2,2) вЂ” you can wire that later by a trigger that places losers.
  end if;

  -- Note: populating losers bracket participants requires capturing semifinal/quarterfinal losers.
  -- We do that via a trigger below.
end;
