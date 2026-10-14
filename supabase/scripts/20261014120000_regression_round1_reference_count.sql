-- Self-contained regression for the production round-1 assignment count query.
-- Run after applying the migration, with ON_ERROR_STOP enabled in psql.
-- Uses temporary rows only and rolls back; no tournament fixtures are required.
-- This isolates validation arithmetic, not the full group-lock trigger flow.
begin;

create temporary table round1_count_matches (
  tournament_id uuid,
  stage text,
  bracket_type text,
  round int,
  bracket_slot int,
  home_participant_id uuid,
  away_participant_id uuid
) on commit drop;

do $test$
declare
  v_definition text := pg_get_functiondef('public.ensure_playoff_bracket(uuid)'::regprocedure);
  v_query text;
  v_tournament_id uuid := '00000000-0000-0000-0000-000000000001';
  v_seed_positions int[] := array[1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11];
  v_n int;
  v_slot int;
  v_home_seed int;
  v_away_seed int;
  v_assigned_refs int;
  v_distinct_assigned int;
begin
  -- Execute the actual query from the installed function so a regression in
  -- the routine fails this fixture instead of merely testing a copied query.
  v_query := substring(v_definition from
    'select\s+[^;]+into v_assigned_refs, v_distinct_assigned[^;]+;');
  if v_query is null then
    raise exception 'Could not locate round-1 reference count query';
  end if;
  v_query := replace(v_query, 'into v_assigned_refs, v_distinct_assigned', '');
  v_query := replace(v_query, 'public.matches', 'pg_temp.round1_count_matches');
  v_query := replace(v_query, 'p_tournament_id', '$1');
  v_query := replace(v_query, 'v_matches_in_round', '$2');

  for v_n in 9..16 loop
    truncate pg_temp.round1_count_matches;
    for v_slot in 1..8 loop
      v_home_seed := v_seed_positions[(v_slot - 1) * 2 + 1];
      v_away_seed := v_seed_positions[(v_slot - 1) * 2 + 2];
      insert into pg_temp.round1_count_matches values (
        v_tournament_id, 'PLAYOFF', 'WINNERS', 1, v_slot,
        case when v_home_seed <= v_n then md5(v_home_seed::text)::uuid end,
        case when v_away_seed <= v_n then md5(v_away_seed::text)::uuid end
      );
    end loop;

    -- Extra rows in other stages, brackets, rounds or noncanonical slots must
    -- not affect validation. An empty canonical match contributes zero refs.
    insert into pg_temp.round1_count_matches
    select v_tournament_id, s.stage, s.bracket_type, s.round, s.slot,
           md5('1')::uuid, md5('2')::uuid
    from (values
      ('GROUP', 'WINNERS', 1, 1),
      ('PLAYOFF', 'LOSERS', 1, 1),
      ('PLAYOFF', 'WINNERS', 2, 1),
      ('PLAYOFF', 'WINNERS', 1, 9),
      ('PLAYOFF', 'WINNERS', 1, null::int)
    ) s(stage, bracket_type, round, slot);
    insert into pg_temp.round1_count_matches values
      (v_tournament_id, 'PLAYOFF', 'WINNERS', 1, 1, null, null),
      ('00000000-0000-0000-0000-000000000002', 'PLAYOFF', 'WINNERS', 1, 1,
       md5('1')::uuid, md5('2')::uuid);

    execute v_query into v_assigned_refs, v_distinct_assigned using v_tournament_id, 8;
    if v_assigned_refs <> v_n or v_distinct_assigned <> v_n then
      raise exception 'Entrants=%: assigned_refs=% distinct_assigned=% (expected %)',
        v_n, v_assigned_refs, v_distinct_assigned, v_n;
    end if;

    -- Genuine duplicate references must remain visible to the guard.
    insert into pg_temp.round1_count_matches values
      (v_tournament_id, 'PLAYOFF', 'WINNERS', 1, 1, md5('1')::uuid, md5('2')::uuid);
    execute v_query into v_assigned_refs, v_distinct_assigned using v_tournament_id, 8;
    if v_assigned_refs <> v_n + 2 or v_distinct_assigned <> v_n then
      raise exception 'Duplicate references were not counted correctly for % entrants', v_n;
    end if;
  end loop;

  truncate pg_temp.round1_count_matches;
  insert into pg_temp.round1_count_matches values
    (v_tournament_id, 'PLAYOFF', 'WINNERS', 1, 1, null, null);
  execute v_query into v_assigned_refs, v_distinct_assigned using v_tournament_id, 8;
  if v_assigned_refs <> 0 or v_distinct_assigned <> 0 then
    raise exception 'Empty matches must contribute zero references';
  end if;
end;
$test$;

rollback;
