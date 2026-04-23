-- Regression checklist for generalized full_with_losers double-elimination generation.
-- Covers entrant counts: 3..16 (spot-check focus list below includes required cases).

-- Run in a staging DB with host/admin auth.
-- This script validates bracket graph shape and bye/flow invariants after:
--   select public.ensure_playoff_bracket(<tournament_id>);

with expected_counts(n) as (
  values (3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15),(16)
)
select n,
       (select ceil(log(2, n::numeric))::int) as winners_rounds,
       (select power(2, ceil(log(2, n::numeric))::int)::int) as bracket_size,
       (select ((ceil(log(2, n::numeric))::int - 1) * 2)) as losers_rounds_without_gf
from expected_counts;

-- Example invariant checks per tournament (replace :tournament_id):
-- 1) no fake loser from BYE winners matches
-- select count(*) = 0 as ok
-- from public.playoff_placement_entrants e
-- join public.matches m on m.id = e.source_match_id
-- where m.tournament_id = :'tournament_id'
--   and (m.home_participant_id is null or m.away_participant_id is null);

-- 2) each winners loss maps to exactly one losers slot
-- select source_match_id, count(*)
-- from public.playoff_placement_entrants
-- where tournament_id = :'tournament_id'
-- group by source_match_id
-- having count(*) <> 1;

-- 3) losers bracket has no orphan connection gaps (except GF2 reset shell)
-- select l.id
-- from public.matches l
-- where l.tournament_id = :'tournament_id'
--   and l.stage='PLAYOFF'
--   and l.bracket_type='LOSERS'
--   and l.round < (select max(round) from public.matches where tournament_id = :'tournament_id' and stage='PLAYOFF' and bracket_type='LOSERS')
--   and l.next_match_id is null;

-- 4) odd-entry rounds have at most one singleton at generation time
-- select round,
--        sum(case when (home_participant_id is null) <> (away_participant_id is null) then 1 else 0 end) as singletons
-- from public.matches
-- where tournament_id = :'tournament_id'
--   and stage='PLAYOFF'
--   and bracket_type='LOSERS'
-- group by round
-- having sum(case when (home_participant_id is null) <> (away_participant_id is null) then 1 else 0 end) > 1;

-- 5) every played competitor who receives a first loss gets a losers-bracket path
--    (no first-loss elimination due to missing drop mapping).
-- with first_losses as (
--   select m.id as source_match_id,
--          case when mr.home_score > mr.away_score then m.away_participant_id else m.home_participant_id end as loser_id
--   from public.matches m
--   join public.match_results mr on mr.match_id = m.id and mr.locked = true
--   where m.tournament_id = :'tournament_id'
--     and m.stage = 'PLAYOFF'
--     and m.bracket_type = 'WINNERS'
--     and m.home_participant_id is not null
--     and m.away_participant_id is not null
-- )
-- select fl.source_match_id
-- from first_losses fl
-- left join public.matches lm
--   on lm.tournament_id = :'tournament_id'
--  and lm.stage = 'PLAYOFF'
--  and lm.bracket_type = 'LOSERS'
--  and (lm.home_participant_id = fl.loser_id or lm.away_participant_id = fl.loser_id)
-- where lm.id is null;
