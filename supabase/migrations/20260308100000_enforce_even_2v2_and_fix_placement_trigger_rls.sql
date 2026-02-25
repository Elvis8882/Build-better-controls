create or replace function public.trg_on_participants_lock_check()
returns trigger
language plpgsql
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

    select preset_id into v_preset from public.tournaments where id = new.tournament_id;

    if v_preset in ('2v2_tournament','2v2_playoffs') and mod(v_total, 2) <> 0 then
      raise exception '2v2 tournaments require an even number of participants';
    end if;

    if v_total >= 3 and v_total = v_locked then
      if v_preset in ('full_with_losers','full_no_losers','2v2_tournament') then
        perform public.generate_group_stage(new.tournament_id);
      else
        perform public.ensure_playoff_bracket(new.tournament_id);
      end if;
    end if;
  end if;

  return new;
end;
$$;

alter function public.trg_place_losers_into_losers_bracket() security definer;
alter function public.trg_place_losers_into_losers_bracket() set search_path = public;
