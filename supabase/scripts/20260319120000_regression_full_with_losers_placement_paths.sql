-- Regression scenarios for public.trg_place_losers_into_losers_bracket
--
-- Scenario A: full_with_losers + 4 entrants (v_max_round = 2)
-- Expected: exactly one LOSERS round=1 slot=1 placement match containing both semifinal losers.
--
-- Scenario B: full_with_losers + 6 entrants (v_max_round >= 3)
-- Expected: existing dynamic losers flow remains unchanged (multiple LOSERS matches by source group/round).
--
-- Usage:
--  1) Create two tournaments with preset_id='full_with_losers': one with 4 entrants, one with 6 entrants.
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
--   LOSERS flow remains dynamically grouped by winners source rounds/slots (no forced single r1s1 collapse).
