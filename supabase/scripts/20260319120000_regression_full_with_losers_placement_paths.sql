-- Regression scenarios for public.trg_place_losers_into_losers_bracket
--
-- Scenario A: full_with_losers + 4 entrants (v_max_round = 2)
-- Expected: exactly one LOSERS round=1 slot=1 placement match containing both semifinal losers.
--
-- Scenario B: full_with_losers + 6 entrants (v_max_round >= 3)
-- Expected: dynamic losers flow remains grouped by winners source rounds/slots.
--
-- Scenario C: full_with_losers + 5 entrants
-- Expected: odd-size flow keeps one semifinal placement game plus one BYE lane;
-- final placement round has a 3rd/4th game and a 5th-place classification shell.
--
-- Scenario D: full_with_losers + 7 entrants
-- Expected: once winners dependencies are known, LOSERS round shells are reconciled and no row
-- with both participants null remains in dependent placement rounds.
--
-- Usage:
--  1) Create fixtures with preset_id='full_with_losers' for 4, 5, 6, and 7 entrants.
--  2) Generate playoff winners brackets.
--  3) Lock winners match results to fire trg_place_losers_into_losers_bracket.
--  4) Run the checks below.

-- Scenario A checks (replace :tournament_id_4 with your 4-entrant fixture UUID)
select
  count(*) as losers_r1s1_count
from public.matches
where tournament_id = :'tournament_id_4'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS'
  and round = 1
  and bracket_slot = 1;

select
  home_participant_id,
  away_participant_id
from public.matches
where tournament_id = :'tournament_id_4'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS'
  and round = 1
  and bracket_slot = 1;

-- Expectation:
--   losers_r1s1_count = 1
--   both home_participant_id and away_participant_id are non-null and distinct.
--   placement_entrants_count = 0 (4-entrant direct semifinal-loser placement path).
--   losers_round_gt_1_count = 0 (no extra LOSERS rounds after 3rd/4th game).

select
  count(*) as placement_entrants_count
from public.playoff_placement_entrants
where tournament_id = :'tournament_id_4';

select
  count(*) as losers_round_gt_1_count
from public.matches
where tournament_id = :'tournament_id_4'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS'
  and round > 1;

-- Scenario B checks (replace :tournament_id_6 with your 6-entrant fixture UUID)
select
  round,
  bracket_slot,
  home_participant_id,
  away_participant_id,
  next_match_id,
  next_match_side
from public.matches
where tournament_id = :'tournament_id_6'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS'
order by round, bracket_slot;

select
  source_round,
  source_group_slot,
  count(*) as entrants
from public.playoff_placement_entrants
where tournament_id = :'tournament_id_6'
group by source_round, source_group_slot
order by source_round, source_group_slot;

-- Expectation:
--   LOSERS flow remains dynamically grouped by winners source rounds/slots.

-- Scenario C checks (replace :tournament_id_5 with your 5-entrant fixture UUID)
select
  round,
  bracket_slot,
  home_participant_id,
  away_participant_id,
  next_match_id,
  next_match_side
from public.matches
where tournament_id = :'tournament_id_5'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS'
order by round, bracket_slot;

select
  count(*) filter (where round = 2 and bracket_slot = 1 and home_participant_id is not null and away_participant_id is not null)
    as third_place_pairings,
  count(*) filter (where round = 2 and bracket_slot = 2 and (home_participant_id is not null or away_participant_id is not null))
    as fifth_place_lane
from public.matches
where tournament_id = :'tournament_id_5'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS';

select
  count(*) as null_shell_matches_after_resolution
from public.matches lm
where lm.tournament_id = :'tournament_id_5'
  and lm.stage = 'PLAYOFF'
  and lm.bracket_type = 'LOSERS'
  and lm.home_participant_id is null
  and lm.away_participant_id is null
  and not exists (
    select 1
    from public.playoff_placement_entrants e
    where e.tournament_id = lm.tournament_id
      and e.source_round = lm.round
  );

-- Scenario D checks (replace :tournament_id_7 with your 7-entrant fixture UUID)
select
  round,
  bracket_slot,
  home_participant_id,
  away_participant_id,
  next_match_id,
  next_match_side
from public.matches
where tournament_id = :'tournament_id_7'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS'
order by round, bracket_slot;

select
  count(*) as null_shell_matches_after_resolution
from public.matches lm
where lm.tournament_id = :'tournament_id_7'
  and lm.stage = 'PLAYOFF'
  and lm.bracket_type = 'LOSERS'
  and lm.home_participant_id is null
  and lm.away_participant_id is null
  and not exists (
    select 1
    from public.playoff_placement_entrants e
    where e.tournament_id = lm.tournament_id
      and e.source_round = lm.round
  );

-- Expectation for scenario C:
--   third_place_pairings = 1
--   fifth_place_lane = 1
--   no duplicate participants across LOSERS round=2 pairings.

-- Expectation for scenario D:
--   null_shell_matches_after_resolution = 0 once all upstream winners dependencies for that
--   placement round are known and locked.
