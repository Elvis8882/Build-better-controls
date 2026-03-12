-- Avoid statement timeouts while locking group matches in full_with_losers tournaments.
-- Rebuild the playoff graph only once, after all group matches are locked.
create or replace function public.trg_on_group_result_lock_reseed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  v_is_full_with_losers boolean := false;
  v_all_group_locked boolean := false;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'GROUP' then
    return new;
  end if;

  select public.preset_is_full_with_losers(preset_id)
  into v_is_full_with_losers
  from public.tournaments
  where id = m.tournament_id;

  select not exists (
    select 1
    from public.matches mx
    left join public.match_results mr on mr.match_id = mx.id
    where mx.tournament_id = m.tournament_id
      and mx.stage = 'GROUP'
      and coalesce(mr.locked,false) = false
  ) into v_all_group_locked;

  -- Full-with-losers rebuilds are expensive; defer until all group results are locked.
  if (not v_is_full_with_losers) or v_all_group_locked then
    perform public.ensure_playoff_bracket(m.tournament_id);
  end if;

  -- if all group matches locked, mark tournament stage to PLAYOFF (optional)
  if v_all_group_locked then
    update public.tournaments set stage = 'PLAYOFF' where id = m.tournament_id;
  end if;

  return new;
end;
$$;
