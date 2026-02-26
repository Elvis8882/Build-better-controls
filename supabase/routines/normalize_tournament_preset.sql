declare
  v_preset text := nullif(trim(p_preset), '');
begin
  if v_preset is null then
    return null;
  end if;

  if v_preset in ('playoffs_only', 'full_with_losers', 'full_no_losers', '2v2_tournament', '2v2_playoffs', 'round_robin_tiers') then
    return v_preset;
  end if;

  if v_preset = 'full_tournament' then
    raise exception 'Legacy tournament preset "%" is not accepted by contract. Run migration/update writer.', v_preset;
  end if;

  raise exception 'Unknown tournament preset "%".', v_preset;
end;
