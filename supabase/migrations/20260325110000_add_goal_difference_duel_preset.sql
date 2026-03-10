alter table public.tournaments
	drop constraint if exists tournaments_preset_check;

alter table public.tournaments
	add constraint tournaments_preset_check
	check (
		preset_id is not null
		and preset_id in (
			'playoffs_only',
			'full_with_losers',
			'full_no_losers',
			'2v2_tournament',
			'2v2_playoffs',
			'round_robin_tiers',
			'goal_difference_duel'
		)
	);

create or replace function public.normalize_tournament_preset(p_preset text)
returns text
language plpgsql
immutable
as $$
declare
  v_preset text := nullif(trim(p_preset), '');
begin
  if v_preset is null then
    return null;
  end if;

  if v_preset in ('playoffs_only', 'full_with_losers', 'full_no_losers', '2v2_tournament', '2v2_playoffs', 'round_robin_tiers', 'goal_difference_duel') then
    return v_preset;
  end if;

  if v_preset = 'full_tournament' then
    raise exception 'Legacy tournament preset "%" is not accepted by contract. Run migration/update writer.', v_preset;
  end if;

  raise exception 'Unknown tournament preset "%".', v_preset;
end;
$$;
