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

      if v_preset in ('full_with_losers','full_no_losers') then
        perform public.generate_group_stage(new.tournament_id);
      else
        perform public.ensure_playoff_bracket(new.tournament_id);
      end if;
    end if;
  end if;

  return new;
end;
