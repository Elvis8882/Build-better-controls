declare
  v_preset text := public.normalize_tournament_preset(p_preset);
begin
  return v_preset in ('2v2_tournament', '2v2_playoffs');
end;
