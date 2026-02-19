declare
  v_preset text;
  v_n int;
  v_s int;
begin
  select preset_id into v_preset from public.tournaments where id = p_tournament_id;
  if v_preset is null then
    return;
  end if;

  select count(*) into v_n from public.tournament_participants where tournament_id = p_tournament_id;
  if v_n < 4 then
    return;
  end if;

  v_s := 1;
  while v_s < v_n loop v_s := v_s * 2; end loop;

  -- For full_no_losers (or playoffs_only), keep a dedicated 3rd-place shell only.
  if v_preset <> 'full_with_losers' then
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
  end if;
end;
