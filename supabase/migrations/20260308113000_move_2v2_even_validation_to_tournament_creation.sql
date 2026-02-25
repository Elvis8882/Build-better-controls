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

    if v_total >= 3 and v_total = v_locked then
      select preset_id into v_preset from public.tournaments where id = new.tournament_id;

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

create or replace function public.trg_tournaments_enforce_even_2v2_default_participants()
returns trigger
language plpgsql
as $$
begin
  if new.preset_id in ('2v2_tournament', '2v2_playoffs') and mod(new.default_participants, 2) <> 0 then
    raise exception '2v2 tournaments require an even default participant count';
  end if;

  return new;
end;
$$;

drop trigger if exists tournaments_enforce_even_2v2_default_participants on public.tournaments;
create trigger tournaments_enforce_even_2v2_default_participants
before insert on public.tournaments
for each row execute function public.trg_tournaments_enforce_even_2v2_default_participants();
