-- Audit installed bracket routines for 9/10/11 entrants, including real
-- home/away seed lookups, 390 outcome trials, and the real group generator.
-- Run after migrations: psql -v ON_ERROR_STOP=1 -f <this file>
-- Uses temporary tables/functions and rolls back. No production rows change.
-- Synthetic group standings stress draw order; rematch frequencies are not
-- estimates of real tournament probabilities. RLS/RPC authorization is not tested.
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
create temporary table tournaments (id uuid, preset_id text, status text default 'Active');
create temporary table tournament_participants (id uuid, tournament_id uuid, team_id uuid);
create temporary table tournament_group_members(group_id uuid, participant_id uuid);
create temporary table tournament_groups (tournament_id uuid);
create temporary table v_playoff_seeds (tournament_id uuid, participant_id uuid, seed int);
create temporary table tournament_playoff_seeds (tournament_id uuid, participant_id uuid, seed int);
create temporary table v_group_standings (tournament_id uuid, participant_id uuid, rank_in_group int, points int, goal_diff int, shots_diff int);
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
    'advance_playoff_byes', 'balance_match_home_away', 'seed_placement_quarterfinals'] loop
    definition := pg_get_functiondef(('public.' || name || case when name like 'trg_%' then '()' else '(uuid)' end)::regprocedure);
    definition := replace(definition, 'public.' || name, 'pg_temp.' || name);
    foreach relation in array array['matches','match_results','tournaments','tournament_participants',
      'tournament_groups','tournament_group_members','v_playoff_seeds','tournament_playoff_seeds','v_group_standings','seed_placement_quarterfinals','sync_match_identities_from_participants',
      'advance_playoff_byes','balance_match_home_away','preset_is_full_with_losers','preset_is_team_based'] loop
      definition := replace(definition, 'public.' || relation, 'pg_temp.' || relation);
    end loop;
    execute definition;
  end loop;
end;
$setup$;
create trigger advance_winner after insert on match_results for each row execute function pg_temp.trg_advance_playoff_winner();
create trigger place_loser after insert on match_results for each row execute function pg_temp.trg_place_losers_into_losers_bracket();

create temporary table audit_trials(n int, trial int, mode text, data jsonb);
create function pg_temp.audit_trial(n int, trial int, mode text) returns jsonb language plpgsql as $body$
declare
 t uuid:=md5('audit')::uuid;
 positions int[]:=array[1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11];
 rd int; slot int; v_match record; played int:=0; home_wins boolean;
 pool uuid[]; actual_byes uuid[]; expected_byes uuid[];
 player_counts jsonb; min_games int; max_games int; max_diff int; rematches int; champion uuid;
begin
 truncate matches,match_results,tournaments,tournament_participants,tournament_groups,tournament_playoff_seeds,v_playoff_seeds,v_group_standings;
 insert into tournaments(id,preset_id) values(t,'full_with_losers');
 insert into tournament_participants select md5(i::text)::uuid,t,null from generate_series(1,n) i;
 insert into tournament_groups values(t);
 insert into tournament_playoff_seeds select t,md5(i::text)::uuid,i from generate_series(1,n) i;
 -- Populate the real home/away seed source (the earlier fixture left this empty).
 insert into v_playoff_seeds select t,md5(i::text)::uuid,i from generate_series(1,n) i;
 insert into v_group_standings
 select t,md5(i::text)::uuid,i,
   (n+1-row_number() over(order by md5(trial::text||':'||i::text)))::int,0,0
 from generate_series(1,n) i;
 perform setseed((trial%1000)/1000.0);
 for rd in 1..4 loop
  for slot in 1..(16/(2^rd))::int loop
   insert into matches(tournament_id,stage,bracket_type,round,bracket_slot,home_participant_id,away_participant_id)
   values(t,'PLAYOFF','WINNERS',rd,slot,
    case when rd=1 and positions[slot*2-1]<=n then md5(positions[slot*2-1]::text)::uuid end,
    case when rd=1 and positions[slot*2]<=n then md5(positions[slot*2]::text)::uuid end);
  end loop;
 end loop;
 update matches child set next_match_id=parent.id,
   next_match_side=case when mod(child.bracket_slot,2)=1 then 'HOME' else 'AWAY' end
 from matches parent where child.round<4 and parent.round=child.round+1 and parent.bracket_slot=ceil(child.bracket_slot/2.0)::int;
 perform pg_temp.build_placement(t,n,16,4);
 perform pg_temp.advance_playoff_byes(t);
 loop
  select mx.* into v_match from matches mx left join match_results r on r.match_id=mx.id
  where r.match_id is null and mx.home_participant_id is not null and mx.away_participant_id is not null
  order by case when mod(trial,2)=0 then mx.bracket_type else 'same' end desc,
   mx.round,case when mod(trial,2)=0 then mx.bracket_slot else -mx.bracket_slot end
  limit 1;
  exit when not found;
  if v_match.home_participant_id=v_match.away_participant_id then raise exception 'Self match'; end if;
  home_wins:=case mode when 'home' then true when 'away' then false else random()<0.5 end;
  insert into match_results values(v_match.id,true,case when home_wins then 3 else 1 end,case when home_wins then 1 else 3 end);
  played:=played+1;
  if played>30 then raise exception 'Nonterminating graph'; end if;
 end loop;
 if played<>2*n-4 then raise exception 'n=% trial=% played %, expected %',n,trial,played,2*n-4; end if;
 if exists(select 1 from matches m left join match_results r on r.match_id=m.id
   where m.bracket_type='LOSERS' and not (m.metadata->>'placement_bye')::boolean and r.match_id is null)
 then raise exception 'Stranded game'; end if;
 if exists(select 1 from matches m join match_results r on r.match_id=m.id where (m.metadata->>'placement_bye')::boolean)
 then raise exception 'BYE counted as played'; end if;
 if (select count(*) from matches where bracket_type='LOSERS' and (metadata->>'placement_bye')::boolean)<>4
 then raise exception 'Wrong structural BYE count'; end if;
 select array_agg(pid order by pid) into actual_byes from (
  select coalesce(home_participant_id,away_participant_id) pid from matches
  where bracket_type='LOSERS' and round=2 and (metadata->>'placement_bye')::boolean
 ) b;
 with losses as (
  select case when r.home_score>r.away_score then m.away_participant_id else m.home_participant_id end pid
  from matches m join match_results r on r.match_id=m.id where m.bracket_type='WINNERS' and m.round in(1,2)
 ), best as (
  select l.pid from losses l join v_group_standings s on s.participant_id=l.pid
  order by s.points desc,s.goal_diff desc,s.shots_diff desc,s.rank_in_group,s.participant_id limit (12-n)
 ) select array_agg(pid order by pid) into expected_byes from best;
 if actual_byes is distinct from expected_byes then raise exception 'Incorrect ranked BYEs'; end if;
 with sides as (
  select m.home_participant_id pid,1 h,0 a from matches m join match_results r on r.match_id=m.id
  union all select m.away_participant_id,0,1 from matches m join match_results r on r.match_id=m.id
 ), counts as (select pid,count(*) games,sum(h) home,sum(a) away from sides group by pid)
 select min(games),max(games),max(abs(home-away)),jsonb_agg(jsonb_build_object('seed',s.seed,'games',c.games,'home',c.home,'away',c.away) order by s.seed)
 into min_games,max_games,max_diff,player_counts from counts c join v_playoff_seeds s on s.participant_id=c.pid;
 if min_games<2 or max_games>6 then raise exception 'Unexpected individual game range'; end if;
 select count(*) into rematches from (
  select least(m.home_participant_id,m.away_participant_id),greatest(m.home_participant_id,m.away_participant_id)
  from matches m join match_results r on r.match_id=m.id group by 1,2 having count(*)>1
 ) repeated;
 select case when r.home_score>r.away_score then m.home_participant_id else m.away_participant_id end into champion
 from matches m join match_results r on r.match_id=m.id where m.bracket_type='WINNERS' and m.round=4;
 return jsonb_build_object('played',played,'min_player_games',min_games,'max_player_games',max_games,'max_home_away_diff',max_diff,
  'repeated_opponent_pairs',rematches,'champion_seed',(select seed from v_playoff_seeds where participant_id=champion),'players',player_counts);
end;
$body$;
do $audit$
declare n int; trial int; mode text;
begin
 for n in 9..11 loop
  for trial in 0..129 loop
   mode:=case trial when 0 then 'home' when 1 then 'away' else 'random' end;
   insert into audit_trials values(n,trial,mode,pg_temp.audit_trial(n,trial,mode));
  end loop;
 end loop;
end;
$audit$;
alter table tournaments add column group_count int;
alter table tournament_groups add column id uuid default gen_random_uuid();
alter table tournament_groups add column group_code text;
alter table tournament_participants add column created_at timestamptz;
alter table tournament_participants add column user_id uuid;
alter table tournament_participants add column guest_id uuid;
create temporary table audit_groups(n int,groups int,games int,min_player_games int,max_player_games int,max_home_away_diff int);
do $setup$
declare definition text; relation text;
begin
 definition:=pg_get_functiondef('public.generate_group_stage(uuid)'::regprocedure);
 definition:=replace(definition,'public.generate_group_stage','pg_temp.generate_group_stage');
 foreach relation in array array['matches','match_results','tournaments','tournament_participants','tournament_groups','tournament_group_members'] loop
  definition:=replace(definition,'public.'||relation,'pg_temp.'||relation);
 end loop;
 execute definition;
end;
$setup$;
do $audit$
declare n int; g int; t uuid:=md5('group-audit')::uuid; total int; expected int; lo int; hi int; imbalance int;
begin
 for n in 9..11 loop
  for g in 2..3 loop
   truncate matches,match_results,tournaments,tournament_participants,tournament_groups,tournament_group_members;
   insert into tournaments(id,preset_id,group_count) values(t,'full_with_losers',g);
   insert into tournament_participants(id,tournament_id,created_at)
   select md5(i::text)::uuid,t,'2026-10-23T00:00:00Z'::timestamptz+make_interval(secs=>i) from generate_series(1,n) i;
   perform pg_temp.generate_group_stage(t);
   select sum(size*(size-1)/2) into expected from (select count(*)::int size from tournament_group_members group by group_id) sizes;
   select count(*) into total from matches;
   if total<>expected then raise exception 'Incorrect group game count'; end if;
   if exists(select 1 from matches group by least(home_participant_id,away_participant_id),greatest(home_participant_id,away_participant_id) having count(*)<>1)
   then raise exception 'Duplicate group pairing'; end if;
   if exists(select 1 from matches where home_participant_id=away_participant_id or home_participant_id is null or away_participant_id is null)
   then raise exception 'Invalid group game'; end if;
   with sides as (
    select home_participant_id pid,1 h,0 a from matches union all select away_participant_id,0,1 from matches
   ), counts as (select pid,count(*) games,sum(h) home,sum(a) away from sides group by pid)
   select min(games),max(games),max(abs(home-away)) into lo,hi,imbalance from counts;
   if imbalance>1 then raise exception 'Group home/away imbalance n=% groups=%',n,g; end if;
   insert into audit_groups values(n,g,total,lo,hi,imbalance);
  end loop;
 end loop;
end;
$audit$;

-- Outcome-independent match counts and observed participant/home-away ranges.
select n, count(*) as trials,
  min((data->>'played')::int) as minimum_playoff_games,
  max((data->>'played')::int) as maximum_playoff_games,
  min((data->>'min_player_games')::int) as minimum_games_per_player,
  max((data->>'max_player_games')::int) as maximum_games_per_player,
  max((data->>'max_home_away_diff')::int) as maximum_home_away_difference,
  count(*) filter(where (data->>'repeated_opponent_pairs')::int>0) as trials_with_repeat_opponents
from audit_trials group by n order by n;

-- A concrete all-away/all-home path, if one was observed.
select distinct on (n) n,trial,p.player
from audit_trials cross join lateral jsonb_array_elements(data->'players') p(player)
where abs((p.player->>'home')::int-(p.player->>'away')::int)=6
order by n,trial;

select n,groups,games as group_games,games+2*n-4 as full_tournament_games,
  min_player_games,max_player_games,max_home_away_diff
from audit_groups order by n,groups;
rollback;
