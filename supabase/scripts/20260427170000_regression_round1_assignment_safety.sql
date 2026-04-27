-- Regression checks for Round-1 winners assignment validation safety.
--
-- Purpose:
-- 1) Verify full_with_losers 10-participant tournaments have exactly 10 Round-1
--    participant references (no stale winners rows inflating assigned_refs).
-- 2) Verify the recent 9..16-specific validation path does not affect historical
--    <=8 full_with_losers generation behavior.
--
-- Usage:
--   Replace psql variables with fixture tournament UUIDs and run after:
--   select public.ensure_playoff_bracket(<tournament_id>);
--
-- Required fixtures:
--   :tournament_id_10        -> full_with_losers, 10 participants
--   :tournament_id_8         -> full_with_losers, 8 participants
--   :tournament_id_6         -> full_with_losers, 6 participants
--   :tournament_id_10_stale  -> full_with_losers, 10 participants (stale-row injection case)

-- =====================================================================
-- Scenario 1: 10 entrants => exactly 10 assigned refs and 10 distinct entrants
-- in winners round 1.
-- =====================================================================
with r1 as (
  select m.home_participant_id, m.away_participant_id
  from public.matches m
  where m.tournament_id = :'tournament_id_10'::uuid
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.round = 1
), agg as (
  select
    coalesce(sum((case when home_participant_id is not null then 1 else 0 end)
               + (case when away_participant_id is not null then 1 else 0 end)), 0) as assigned_refs,
    (
      select count(distinct pid)
      from (
        select home_participant_id as pid from r1 where home_participant_id is not null
        union all
        select away_participant_id as pid from r1 where away_participant_id is not null
      ) x
    ) as distinct_assigned
  from r1
)
select *
from agg
where assigned_refs <> 10
   or distinct_assigned <> 10;
-- Expected output: 0 rows.

-- =====================================================================
-- Scenario 2: <=8 behavior unchanged (8 entrants):
-- canonical winners R1 occupancy is 4 full matches, 0 byes, 0 empty matches.
-- =====================================================================
with r1 as (
  select m.home_participant_id, m.away_participant_id
  from public.matches m
  where m.tournament_id = :'tournament_id_8'::uuid
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.round = 1
), agg as (
  select
    count(*) as total_matches,
    sum(case when home_participant_id is not null and away_participant_id is not null then 1 else 0 end) as full_matches,
    sum(case when (home_participant_id is null) <> (away_participant_id is null) then 1 else 0 end) as bye_matches,
    sum(case when home_participant_id is null and away_participant_id is null then 1 else 0 end) as empty_matches
  from r1
)
select *
from agg
where total_matches <> 4
   or full_matches <> 4
   or bye_matches <> 0
   or empty_matches <> 0;
-- Expected output: 0 rows.

-- =====================================================================
-- Scenario 3: <=8 behavior unchanged (6 entrants):
-- canonical 8-slot winners R1 occupancy is 2 full matches + 2 byes, 0 empty.
-- =====================================================================
with r1 as (
  select m.home_participant_id, m.away_participant_id
  from public.matches m
  where m.tournament_id = :'tournament_id_6'::uuid
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.round = 1
), agg as (
  select
    count(*) as total_matches,
    sum(case when home_participant_id is not null and away_participant_id is not null then 1 else 0 end) as full_matches,
    sum(case when (home_participant_id is null) <> (away_participant_id is null) then 1 else 0 end) as bye_matches,
    sum(case when home_participant_id is null and away_participant_id is null then 1 else 0 end) as empty_matches
  from r1
)
select *
from agg
where total_matches <> 4
   or full_matches <> 2
   or bye_matches <> 2
   or empty_matches <> 0;
-- Expected output: 0 rows.

-- =====================================================================
-- Scenario 4: stale WINNERS round=1 bracket_slot=NULL rows are pruned before
-- round-1 assignment validation, so assigned refs still equals participant count.
-- =====================================================================
insert into public.matches (
  tournament_id,
  stage,
  bracket_type,
  round,
  bracket_slot,
  home_participant_id,
  away_participant_id
)
values (
  :'tournament_id_10_stale'::uuid,
  'PLAYOFF',
  'WINNERS',
  1,
  null,
  null,
  null
);

select public.ensure_playoff_bracket(:'tournament_id_10_stale'::uuid);

with participant_counts as (
  select count(*)::int as participant_count
  from public.participants p
  where p.tournament_id = :'tournament_id_10_stale'::uuid
), r1 as (
  select m.home_participant_id, m.away_participant_id
  from public.matches m
  where m.tournament_id = :'tournament_id_10_stale'::uuid
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.round = 1
), agg as (
  select
    coalesce(sum((case when home_participant_id is not null then 1 else 0 end)
               + (case when away_participant_id is not null then 1 else 0 end)), 0)::int as assigned_refs,
    (
      select count(distinct pid)::int
      from (
        select home_participant_id as pid from r1 where home_participant_id is not null
        union all
        select away_participant_id as pid from r1 where away_participant_id is not null
      ) x
    ) as distinct_assigned
  from r1
)
select agg.assigned_refs, agg.distinct_assigned, pc.participant_count
from agg
cross join participant_counts pc
where agg.assigned_refs <> pc.participant_count
   or agg.distinct_assigned <> pc.participant_count;
-- Expected output: 0 rows.
