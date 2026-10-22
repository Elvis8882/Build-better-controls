-- Self-contained tests of the INSTALLED placement builder and advancement triggers.
-- No production rows are touched. Run after migrations with psql -v ON_ERROR_STOP=1 -f <file>.
-- Uses temporary stand-ins for tables and identity syncing, keeping the real
-- graph, drop routing, winner routing, BYE guard and home/away balancing bodies.
begin;
create temporary table matches (
  id uuid primary key default gen_random_uuid(), tournament_id uuid, stage text, bracket_type text,
  round int, bracket_slot int, metadata jsonb default '{}',
  next_match_id uuid, next_match_side text, home_participant_id uuid, away_participant_id uuid,
  home_user_id uuid, away_user_id uuid, home_guest_id uuid, away_guest_id uuid,
  unique(tournament_id, stage, bracket_type, round, bracket_slot)
);
create temporary table match_results (match_id uuid primary key, locked boolean, home_score int, away_score int);
create temporary table tournaments (id uuid, preset_id text);
create temporary table tournament_participants (id uuid, tournament_id uuid, team_id uuid);
create temporary table tournament_groups (tournament_id uuid);
create temporary table v_playoff_seeds (tournament_id uuid, participant_id uuid, seed int);
create temporary table playoff_placement_entrants (tournament_id uuid);
create function pg_temp.sync_match_identities_from_participants(uuid) returns void language plpgsql as 'begin return; end;';
create function pg_temp.preset_is_full_with_losers(text) returns boolean language sql as 'select true';
create function pg_temp.preset_is_team_based(text) returns boolean language sql as 'select false';

do $setup$
declare
  definition text;
  declarations text;
  graph text;
  name text;
  relation text;
begin
  definition := pg_get_functiondef('public.ensure_playoff_bracket(uuid)'::regprocedure);
  declarations := substring(definition from E'declare(.*?)\nbegin');
  graph := substring(definition from position('  -- A placement match' in definition));
  graph := left(graph, position(E'\n  if v_is_full_with_losers and v_n >= 3' in graph) - 1);
  if declarations is null or graph is null or length(graph) < 100 then
    raise exception 'Unable to extract installed placement graph';
  end if;
  declarations := regexp_replace(declarations, E'  v_(n|s|rounds) int;\n', '', 'g');
  graph := replace(graph, 'public.matches', 'pg_temp.matches');
  graph := replace(graph, 'public.playoff_placement_entrants', 'pg_temp.playoff_placement_entrants');
  execute 'create function pg_temp.build_placement(p_tournament_id uuid, v_n int, v_s int, v_rounds int)
    returns void language plpgsql as $body$ declare ' || declarations || E'\nbegin\n'
    || 'v_is_full_with_losers := true;' || graph || E'\nend; $body$';

  foreach name in array array['trg_advance_playoff_winner', 'trg_place_losers_into_losers_bracket',
    'advance_playoff_byes', 'balance_match_home_away'] loop
    definition := pg_get_functiondef(('public.' || name || case when name like 'trg_%' then '()' else '(uuid)' end)::regprocedure);
    definition := replace(definition, 'public.' || name, 'pg_temp.' || name);
    foreach relation in array array['matches','match_results','tournaments','tournament_participants',
      'tournament_groups','v_playoff_seeds','sync_match_identities_from_participants',
      'advance_playoff_byes','balance_match_home_away','preset_is_full_with_losers','preset_is_team_based'] loop
      definition := replace(definition, 'public.' || relation, 'pg_temp.' || relation);
    end loop;
    execute definition;
  end loop;
end;
$setup$;
create trigger advance_winner after insert on match_results for each row execute function pg_temp.trg_advance_playoff_winner();
create trigger place_loser after insert on match_results for each row execute function pg_temp.trg_place_losers_into_losers_bracket();

do $test$
declare
  n int;
  size int;
  rounds int;
  seed_positions int[];
  next_positions int[];
  pos int;
  slot int;
  rd int;
  scenario int;
  t uuid := md5('fixture')::uuid;
  m record;
  target uuid;
  played int;
  source_count int;
  expected int;
begin
  for n in 3..16 loop
    -- Test WB-first and interleaved reverse-slot lock ordering, alternating scores.
    for scenario in 1..2 loop
      truncate matches, match_results, tournaments, tournament_participants;
      insert into tournaments values(t, 'full_with_losers');
      insert into tournament_participants select md5(i::text)::uuid, t, null from generate_series(1,n) i;
      size := 1;
      rounds := 0;
      while size < n loop size := size * 2; rounds := rounds + 1; end loop;
      seed_positions := array[1,2];
      while array_length(seed_positions,1) < size loop
        next_positions := '{}';
        foreach pos in array seed_positions loop
          next_positions := array_append(next_positions, pos);
          next_positions := array_append(next_positions, array_length(seed_positions,1)*2+1-pos);
        end loop;
        seed_positions := next_positions;
      end loop;
      -- Also exercise a packed group pairing layout with an empty R1 shell.
      if scenario = 2 and n = 5 then
        seed_positions := array[1,2,3,4,5,6,7,8];
      end if;
      for rd in 1..rounds loop
        for slot in 1..(size / (2^rd))::int loop
          insert into matches(tournament_id,stage,bracket_type,round,bracket_slot,home_participant_id,away_participant_id)
          values(t,'PLAYOFF','WINNERS',rd,slot,
            case when rd = 1 and seed_positions[slot*2-1] <= n then md5(seed_positions[slot*2-1]::text)::uuid end,
            case when rd = 1 and seed_positions[slot*2] <= n then md5(seed_positions[slot*2]::text)::uuid end);
        end loop;
      end loop;
      update matches child set next_match_id = parent.id,
        next_match_side = case when mod(child.bracket_slot,2)=1 then 'HOME' else 'AWAY' end
      from matches parent where child.round < rounds and parent.round = child.round+1
        and parent.bracket_slot = ceil(child.bracket_slot/2.0)::int;
      perform pg_temp.build_placement(t,n,size,rounds);
      -- Every ordinary placement game has two distinct, exclusive incoming sources.
      for m in select * from matches where bracket_type='LOSERS' and not (metadata ? 'lb_loss_home_round') loop
        select count(*) into source_count from matches where next_match_id=m.id;
        source_count := source_count + case when m.metadata ? 'wb_drop_home_round' then 1 else 0 end
          + case when m.metadata ? 'wb_drop_away_round' then 1 else 0 end;
        expected := case when n=3 then 1 else 2 end;
        if source_count <> expected then raise exception 'n=% source count % expected %', n,source_count,expected; end if;
        if exists (select 1 from matches where next_match_id=m.id group by next_match_side having count(*)>1) then
          raise exception 'n=% colliding winner edges',n;
        end if;
      end loop;
      perform pg_temp.advance_playoff_byes(t);
      played := 0;
      loop
        select mx.* into m from matches mx left join match_results r on r.match_id=mx.id
        where r.match_id is null and mx.home_participant_id is not null and mx.away_participant_id is not null
        order by case when scenario=1 then mx.bracket_type else 'same' end desc,
          mx.round asc, case when scenario=2 then -mx.bracket_slot else mx.bracket_slot end
        limit 1;
        exit when not found;
        if m.home_participant_id=m.away_participant_id then raise exception 'Self match'; end if;
        insert into match_results values(m.id,true,
          case when mod(played+scenario,2)=0 then 3 else 1 end,
          case when mod(played+scenario,2)=0 then 1 else 3 end);
        played := played+1;
        if played>50 then raise exception 'Nonterminating bracket'; end if;
      end loop;
      if exists(select 1 from matches mx left join match_results r on r.match_id=mx.id
        where mx.bracket_type='LOSERS' and r.match_id is null and not coalesce((mx.metadata->>'placement_bye')::boolean,false)) then
        raise exception 'n=% scenario=% stranded placement game',n,scenario;
      end if;
      if played <> (n-1)+greatest(n-3,0)+case when n=8 then 2 else 0 end then
        raise exception 'n=% scenario=% unexpected played count %',n,scenario,played;
      end if;
      -- No championship finalist may appear in placement.
      if exists(select 1 from matches final join matches lb on lb.bracket_type='LOSERS'
        and (final.home_participant_id in(lb.home_participant_id,lb.away_participant_id)
          or final.away_participant_id in(lb.home_participant_id,lb.away_participant_id))
        where final.bracket_type='WINNERS' and final.round=rounds) then
        raise exception 'Finalist entered placement';
      end if;
    end loop;
  end loop;
end;
$test$;
rollback;
