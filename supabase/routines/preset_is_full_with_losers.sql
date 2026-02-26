declare
  v_preset text := public.normalize_tournament_preset(p_preset);
begin
  return v_preset = 'full_with_losers';
end;
