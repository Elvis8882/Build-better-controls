-- Self-contained tests of the INSTALLED full group draw and advancement triggers.
-- No production rows are touched. Run after migrations with psql -v ON_ERROR_STOP=1 -f <file>.
-- Uses temporary data relations and preset predicates, with the real generator,
-- routing, BYE handling, home priority and user/guest identity synchronization.
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
create temporary table tournament_participants (id uuid, tournament_id uuid, team_id uuid, created_at timestamptz default now(), user_id uuid, guest_id uuid);
create temporary table tournament_group_members(group_id uuid, participant_id uuid);
create temporary table tournament_groups (tournament_id uuid, id uuid, group_code text);
create temporary table v_playoff_seeds (tournament_id uuid, participant_id uuid, seed int);
create temporary table tournament_playoff_seeds (tournament_id uuid, participant_id uuid, seed int);
create temporary table v_group_standings (tournament_id uuid, participant_id uuid, rank_in_group int, points int, goal_diff int, shots_diff int);
create temporary table playoff_placement_entrants (tournament_id uuid);
create function pg_temp.preset_is_full_with_losers(text) returns boolean language sql as 'select true';
create function pg_temp.preset_is_team_based(text) returns boolean language sql as 'select false';

do $setup$
declare
  definition text;
  name text;
  relation text;
begin
  foreach name in array array['trg_advance_playoff_winner', 'trg_place_losers_into_losers_bracket',
    'advance_playoff_byes', 'balance_match_home_away', 'seed_placement_quarterfinals',
    'seed_cross_group_winners_round1', 'ensure_playoff_bracket', 'sync_match_identities_from_participants'] loop
    definition := pg_get_functiondef(('public.' || name || case when name like 'trg_%' then '()' when name = 'seed_cross_group_winners_round1' then '(uuid,uuid[])' else '(uuid)' end)::regprocedure);
    definition := replace(definition, 'public.' || name, 'pg_temp.' || name);
    foreach relation in array array['matches','match_results','tournaments','tournament_participants',
      'tournament_groups','tournament_group_members','playoff_placement_entrants','v_playoff_seeds','tournament_playoff_seeds','v_group_standings','seed_placement_quarterfinals','sync_match_identities_from_participants',
      'seed_cross_group_winners_round1','advance_playoff_byes','balance_match_home_away','preset_is_full_with_losers','preset_is_team_based'] loop
      definition := replace(definition, 'public.' || relation, 'pg_temp.' || relation);
    end loop;
    execute definition;
  end loop;
end;
$setup$;
create trigger advance_winner after insert on match_results for each row execute function pg_temp.trg_advance_playoff_winner();
create trigger place_loser after insert on match_results for each row execute function pg_temp.trg_place_losers_into_losers_bracket();

-- Exercise the entire installed generator, not just its placement builder.
do $test$
declare
  n int;
  groups int;
  tree_size int;
  scenario int;
  t uuid := md5('group-fixture')::uuid;
  v_match record;
  played int;
  rank_home int;
  rank_away int;
  loss_home int;
  loss_away int;
  q1 int;
  q2 int;
  snapshot jsonb;
begin
  for n in 6..16 loop
    tree_size:=1;
    while tree_size<n loop tree_size:=tree_size*2;end loop;
    for groups in 2..3 loop
      continue when groups=3 and n<9;
      for scenario in 0..2 loop
        truncate matches, match_results, tournaments, tournament_participants, tournament_groups,
          tournament_group_members, tournament_playoff_seeds, v_playoff_seeds, v_group_standings;
        insert into tournaments(id,preset_id) values(t,'full_with_losers');
        insert into tournament_participants(id,tournament_id,user_id,guest_id) select md5(i::text)::uuid,t,case when i%2=0 then md5((i+100)::text)::uuid end,case when i%2=1 then md5((i+200)::text)::uuid end from generate_series(1,n) i;
        insert into tournament_groups select t,md5(('group-'||i)::text)::uuid,chr(64+i) from generate_series(1,groups) i;
        insert into tournament_group_members
          select md5(('group-'||(case when scenario=2 then least(groups,1+(i-1)*groups/n)
            else 1+mod(i-1,groups) end))::text)::uuid, md5(i::text)::uuid from generate_series(1,n) i;
        -- v_playoff_seeds is deliberately ordered by whole groups, unlike overall rank.
        insert into v_playoff_seeds select t,p.id,row_number() over(order by gm.group_id, gs.i)::int
          from generate_series(1,n) gs(i) join tournament_participants p on p.id=md5(gs.i::text)::uuid
          join tournament_group_members gm on gm.participant_id=p.id;
        insert into v_group_standings select t,md5(i::text)::uuid,i,100-i,0,0 from generate_series(1,n) i;
        perform pg_temp.ensure_playoff_bracket(t);
        if (select count(*) from matches where bracket_type='WINNERS' and round=1
            and (home_participant_id is null or away_participant_id is null)) <> tree_size-n then
          raise exception 'Wrong WB BYE count n=% groups=%',n,groups;
        end if;
        if exists(select 1 from matches m join v_group_standings s
            on s.participant_id=coalesce(m.home_participant_id,m.away_participant_id)
            where m.bracket_type='WINNERS' and m.round=1
              and (m.home_participant_id is null or m.away_participant_id is null) and s.rank_in_group>tree_size-n) then
          raise exception 'A lower overall seed received a WB BYE';
        end if;
        if n>=9 and (select count(distinct ceil(m.bracket_slot/2.0)) from matches m
            cross join lateral(values(m.home_participant_id),(m.away_participant_id)) p(id)
            join v_group_standings s on s.participant_id=p.id
            where m.bracket_type='WINNERS' and m.round=1 and s.rank_in_group<=4) <> 4 then
          raise exception 'Top four must occupy separate quarters';
        end if;
        select ceil(m.bracket_slot/(tree_size/4.0))::int into q1 from matches m where m.bracket_type='WINNERS' and m.round=1
          and md5('1')::uuid in(m.home_participant_id,m.away_participant_id);
        select ceil(m.bracket_slot/(tree_size/4.0))::int into q2 from matches m where m.bracket_type='WINNERS' and m.round=1
          and md5('2')::uuid in(m.home_participant_id,m.away_participant_id);
        if q1=q2 then raise exception 'Top two must occupy opposite halves'; end if;
        -- With alternating balanced groups all opening games can cross groups.
        if scenario<2 and exists(select 1 from matches m
            join tournament_group_members a on a.participant_id=m.home_participant_id
            join tournament_group_members b on b.participant_id=m.away_participant_id
            where m.bracket_type='WINNERS' and m.round=1 and a.group_id=b.group_id) then
          raise exception 'Avoidable same-group opener n=% groups=%',n,groups;
        end if;
        if exists(select 1 from matches mx
          left join tournament_participants h on h.id=mx.home_participant_id
          left join tournament_participants a on a.id=mx.away_participant_id
          where mx.home_user_id is distinct from h.user_id or mx.home_guest_id is distinct from h.guest_id
            or mx.away_user_id is distinct from a.user_id or mx.away_guest_id is distinct from a.guest_id) then
          raise exception 'Draw identity fields do not match participants';
        end if;
        played:=0;
        loop
          select mx.* into v_match from matches mx left join match_results r on r.match_id=mx.id
            where r.match_id is null and mx.home_participant_id is not null and mx.away_participant_id is not null
            order by mx.round,case when scenario=1 then -mx.bracket_slot else mx.bracket_slot end,mx.bracket_type desc limit 1;
          exit when not found;
          select rank_in_group into rank_home from v_group_standings where participant_id=v_match.home_participant_id;
          select rank_in_group into rank_away from v_group_standings where participant_id=v_match.away_participant_id;
          loss_home:=null;loss_away:=null;
          if v_match.bracket_type='LOSERS' then
            select max(w.round) filter(where loser.id=v_match.home_participant_id),
                   max(w.round) filter(where loser.id=v_match.away_participant_id) into loss_home,loss_away
            from matches w join match_results r on r.match_id=w.id
            cross join lateral(select case when r.home_score>r.away_score then w.away_participant_id else w.home_participant_id end id) loser
            where w.bracket_type='WINNERS' and r.locked;
          end if;
          if loss_home is not null and loss_away is not null and loss_home<>loss_away then
            if loss_home<loss_away then raise exception 'Later WB loser must be home'; end if;
          elsif rank_home>rank_away then
            raise exception 'Better overall group rank must be home: n=% groups=% bracket=% round=%',n,groups,v_match.bracket_type,v_match.round;
          end if;
          if v_match.home_user_id is distinct from(select user_id from tournament_participants where id=v_match.home_participant_id)
             or v_match.away_guest_id is distinct from(select guest_id from tournament_participants where id=v_match.away_participant_id) then
            raise exception 'Home/away identity swap failed';
          end if;
          insert into match_results values(v_match.id,true,
            case when mod(played+scenario,2)=0 then 3 else 1 end,
            case when mod(played+scenario,2)=0 then 1 else 3 end);
          played:=played+1;
          if played>40 then raise exception 'Bracket did not terminate';end if;
        end loop;
        if played<>2*n-4+(case when n=8 then 2 else 0 end) then raise exception 'Wrong played total: n=% groups=% games=%',n,groups,played;end if;
        if exists(select 1 from matches m left join match_results r on r.match_id=m.id
            where m.bracket_type='LOSERS' and not coalesce((metadata->>'placement_bye')::boolean,false) and r.match_id is null) then
          raise exception 'Stranded placement game';
        end if;
        select jsonb_agg(to_jsonb(m) order by m.id) into snapshot from matches m;
        perform pg_temp.ensure_playoff_bracket(t);
        for v_match in select id from matches loop perform pg_temp.balance_match_home_away(v_match.id);end loop;
        if snapshot is distinct from(select jsonb_agg(to_jsonb(m) order by m.id) from matches m) then
          raise exception 'Locked bracket was modified';
        end if;
      end loop;
    end loop;
  end loop;
end;
$test$;
-- Explicit fallback, metadata-routing, closed-state and locked-result cases.
alter table match_results disable trigger user;
truncate matches, match_results;
do $edges$
declare
  t uuid := md5('group-fixture')::uuid;
  target uuid := md5('home-target')::uuid;
  source uuid := md5('home-source')::uuid;
  first_loss uuid := md5('first-loss')::uuid;
  later_loss uuid := md5('later-loss')::uuid;
  strongest uuid := md5('1')::uuid;
  weakest uuid := md5('16')::uuid;
  variant int;
begin
  insert into matches(id,tournament_id,stage,bracket_type,round,bracket_slot,home_participant_id,away_participant_id)
    values(first_loss,t,'PLAYOFF','WINNERS',1,1,strongest,md5('2')::uuid),
      (later_loss,t,'PLAYOFF','WINNERS',2,1,weakest,md5('15')::uuid),
      (target,t,'PLAYOFF','LOSERS',6,1,strongest,weakest);
  insert into matches(id,tournament_id,next_match_id,next_match_side) values(source,t,target,'HOME');
  insert into match_results values(first_loss,true,1,3),(later_loss,true,1,3);
  update matches set metadata=jsonb_build_object('wb_drop_home_round',1,'wb_drop_home_slot',1,
      'wb_drop_away_round',2,'wb_drop_away_slot',1) where id=target;
  perform pg_temp.balance_match_home_away(target);
  if not exists(select 1 from matches where id=target and home_participant_id=weakest
      and (metadata->>'wb_drop_home_round')::int=2 and (metadata->>'wb_drop_away_round')::int=1)
      or not exists(select 1 from matches where id=source and next_match_side='AWAY') then
    raise exception 'Side-specific source routing must follow a home/away swap';
  end if;

  -- Locked and closed targets keep their existing orientation.
  update matches set home_participant_id=strongest,away_participant_id=weakest where id=target;
  insert into match_results values(target,true,1,3);
  perform pg_temp.balance_match_home_away(target);
  if (select home_participant_id from matches where id=target)<>strongest then
    raise exception 'Locked match changed sides';end if;
  delete from match_results where match_id=target;
  update tournaments set status='Closed' where id=t;
  perform pg_temp.balance_match_home_away(target);
  if (select home_participant_id from matches where id=target)<>strongest then
    raise exception 'Closed tournament changed sides';end if;
  update tournaments set status='Active' where id=t;

  -- Same loss stage, unknown, unlocked, tied and BYE losses all use overall rank.
  for variant in 1..5 loop
    update matches set home_participant_id=weakest,away_participant_id=strongest where id=target;
    update matches set round=case when variant=1 then 1 else 2 end, bracket_slot=2,
      away_participant_id=case when variant=5 then null else md5('15')::uuid end where id=later_loss;
    delete from match_results where match_id=later_loss;
    if variant<>2 then
      insert into match_results values(later_loss,variant<>3,case when variant=4 then 3 else 1 end,3);
    end if;
    perform pg_temp.balance_match_home_away(target);
    if (select home_participant_id from matches where id=target)<>strongest then
      raise exception 'Overall rank fallback failed for case %',variant;end if;
  end loop;
  -- No group standings: use the persisted playoff seed for both participants.
  truncate v_group_standings, tournament_playoff_seeds;
  insert into tournament_playoff_seeds values(t,weakest,1),(t,strongest,2);
  perform pg_temp.balance_match_home_away(target);
  if (select home_participant_id from matches where id=target)<>weakest then
    raise exception 'Persisted seed fallback failed';end if;
end;
$edges$;
-- Deliberately make conventional seed pairs same-group: 3(A)-6(A), 4(B)-5(B).
-- The draw must retain BYEs 1/2 and instead choose 3(A)-5(B), 4(B)-6(A).
truncate matches,match_results,tournaments,tournament_participants,tournament_groups,
  tournament_group_members,v_group_standings,tournament_playoff_seeds;
do $placement_groups$
declare
  t uuid := md5('placement-groups')::uuid;
  source uuid;
  v_index int;
begin
  insert into tournaments(id,preset_id) values(t,'full_with_losers');
  insert into tournament_participants(id,tournament_id,user_id)
    select md5(i::text)::uuid,t,md5((i+100)::text)::uuid from generate_series(1,10) i;
  insert into tournament_groups values(t,md5('A')::uuid,'A'),(t,md5('B')::uuid,'B');
  insert into tournament_group_members
    select md5(case when i in(1,3,6,7,9) then 'A' else 'B' end)::uuid,md5(i::text)::uuid from generate_series(1,10) i;
  insert into v_group_standings select t,md5(i::text)::uuid,i,100-i,0,0 from generate_series(1,10) i;
  for v_index in 1..6 loop
    insert into matches(tournament_id,stage,bracket_type,round,bracket_slot,home_participant_id,away_participant_id)
      values(t,'PLAYOFF','WINNERS',case when v_index<=2 then 1 else 2 end,
        case when v_index<=2 then v_index else v_index-2 end,md5((7+mod(v_index,4))::text)::uuid,md5(v_index::text)::uuid)
      returning id into source;
    insert into match_results values(source,true,3,1);
  end loop;
  for v_index in 1..4 loop
    insert into matches(tournament_id,stage,bracket_type,round,bracket_slot,metadata)
      values(t,'PLAYOFF','LOSERS',2,v_index,'{"placement_seed_pending":true,"placement_graph_version":2}');
  end loop;
  perform pg_temp.seed_placement_quarterfinals(t);
  if not exists(select 1 from matches where bracket_type='LOSERS'
      and md5('3')::uuid in(home_participant_id,away_participant_id)
      and md5('5')::uuid in(home_participant_id,away_participant_id))
     or not exists(select 1 from matches where bracket_type='LOSERS'
      and md5('4')::uuid in(home_participant_id,away_participant_id)
      and md5('6')::uuid in(home_participant_id,away_participant_id)) then
    raise exception 'Placement draw failed to avoid same-group pairs within seed bands';
  end if;
end;
$placement_groups$;
rollback;
