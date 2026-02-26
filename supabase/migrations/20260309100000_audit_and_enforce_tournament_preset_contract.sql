do $$
declare
  v_audit jsonb;
  v_full_tournament_count int;
  v_unknown_count int;
begin
  select coalesce(jsonb_object_agg(coalesce(preset_id, 'NULL'), row_count), '{}'::jsonb)
  into v_audit
  from (
    select preset_id, count(*)::int as row_count
    from public.tournaments
    group by preset_id
  ) as preset_counts;

  raise notice 'tournaments.preset_id audit before migration: %', v_audit;

  select count(*)::int
  into v_full_tournament_count
  from public.tournaments
  where preset_id = 'full_tournament';

  if v_full_tournament_count > 0 then
    update public.tournaments
    set preset_id = 'full_no_losers'
    where preset_id = 'full_tournament';

    raise notice 'migrated % tournaments from full_tournament to full_no_losers', v_full_tournament_count;
  end if;

  select count(*)::int
  into v_unknown_count
  from public.tournaments
  where preset_id is not null
    and preset_id not in ('playoffs_only', 'full_with_losers', 'full_no_losers', '2v2_tournament', '2v2_playoffs');

  if v_unknown_count > 0 then
    raise exception 'Found % tournaments with unsupported preset_id values after migration.', v_unknown_count;
  end if;
end $$;

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

  if v_preset in ('playoffs_only', 'full_with_losers', 'full_no_losers', '2v2_tournament', '2v2_playoffs') then
    return v_preset;
  end if;

  if v_preset = 'full_tournament' then
    raise exception 'Legacy tournament preset "%" is not accepted by contract. Run migration/update writer.', v_preset;
  end if;

  raise exception 'Unknown tournament preset "%".', v_preset;
end;
$$;

create or replace function public.preset_is_team_based(p_preset text)
returns boolean
language plpgsql
immutable
as $$
declare
  v_preset text := public.normalize_tournament_preset(p_preset);
begin
  return v_preset in ('2v2_tournament', '2v2_playoffs');
end;
$$;

create or replace function public.preset_is_playoff_only(p_preset text)
returns boolean
language plpgsql
immutable
as $$
declare
  v_preset text := public.normalize_tournament_preset(p_preset);
begin
  return v_preset in ('playoffs_only', '2v2_playoffs');
end;
$$;

create or replace function public.preset_is_full_with_losers(p_preset text)
returns boolean
language plpgsql
immutable
as $$
declare
  v_preset text := public.normalize_tournament_preset(p_preset);
begin
  return v_preset = 'full_with_losers';
end;
$$;
