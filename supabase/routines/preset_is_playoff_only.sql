declare
  v_preset text := public.normalize_tournament_preset(p_preset);
begin
  return v_preset in ('playoffs_only', '2v2_playoffs');
end;
