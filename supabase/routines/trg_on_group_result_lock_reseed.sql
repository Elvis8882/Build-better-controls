declare
  m record;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'GROUP' then
    return new;
  end if;

  perform public.ensure_playoff_bracket(m.tournament_id);

  -- if all group matches locked, mark tournament stage to PLAYOFF (optional)
  if not exists (
    select 1
    from public.matches mx
    left join public.match_results mr on mr.match_id = mx.id
    where mx.tournament_id = m.tournament_id
      and mx.stage = 'GROUP'
      and coalesce(mr.locked,false) = false
  ) then
    update public.tournaments set stage = 'PLAYOFF' where id = m.tournament_id;
  end if;

  return new;
end;
