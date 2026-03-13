-- Regression scenarios for public.trg_place_losers_into_losers_bracket
--
-- Scenario A: full_with_losers + 4 entrants
-- Scenario B: full_with_losers + 6 entrants
-- Scenario C: full_with_losers + 8 entrants
--
-- Usage:
--  1) Create fixtures with preset_id='full_with_losers' for 4, 6, and 8 entrants.
--  2) Generate playoff winners brackets.
--  3) Lock winners match results to fire trg_place_losers_into_losers_bracket.
--  4) Run the checks below.

-- =====================================================================
-- Scenario A checks (replace :tournament_id_4 with your 4-entrant fixture UUID)
-- =====================================================================

select
  count(*) as losers_r1s1_count
from public.matches
where tournament_id = :'tournament_id_4'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS'
  and round = 1
  and bracket_slot = 1;
-- Expected output: losers_r1s1_count = 1.

select
  home_participant_id,
  away_participant_id
from public.matches
where tournament_id = :'tournament_id_4'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS'
  and round = 1
  and bracket_slot = 1;
-- Expected output: exactly 1 row; both participants are non-null and distinct.

select
  count(*) as placement_entrants_count
from public.playoff_placement_entrants
where tournament_id = :'tournament_id_4';
-- Expected output: placement_entrants_count = 0 (direct semifinal-loser placement path).

select
  count(*) as losers_round_gt_1_count
from public.matches
where tournament_id = :'tournament_id_4'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS'
  and round > 1;
-- Expected output: losers_round_gt_1_count = 0.

-- =====================================================================
-- Scenario B checks (replace :tournament_id_6 with your 6-entrant fixture UUID)
-- =====================================================================

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
-- Expected output: LOSERS flow rows remain grouped by winners source rounds/slots.

select
  source_round,
  source_group_slot,
  count(*) as entrants
from public.playoff_placement_entrants
where tournament_id = :'tournament_id_6'
group by source_round, source_group_slot
order by source_round, source_group_slot;
-- Expected output: entrant counts align to LOSERS round/bracket_slot buckets.

-- =====================================================================
-- Scenario C checks (replace :tournament_id_8 with your 8-entrant fixture UUID)
-- =====================================================================

select
  round,
  bracket_slot,
  home_participant_id,
  away_participant_id,
  next_match_id,
  next_match_side
from public.matches
where tournament_id = :'tournament_id_8'
  and stage = 'PLAYOFF'
  and bracket_type = 'LOSERS'
order by round, bracket_slot;
-- Expected output: LOSERS bracket rows are populated with no orphan round gaps.

select
  source_round,
  source_group_slot,
  count(*) as entrants
from public.playoff_placement_entrants
where tournament_id = :'tournament_id_8'
group by source_round, source_group_slot
order by source_round, source_group_slot;
-- Expected output: source buckets are present and balanced for 8-entrant WB loss flow.

-- =====================================================================
-- Shared invariants across 4, 6, 8 entrants
-- =====================================================================

-- Invariant 1: every LB participant must have a prior locked WB loss event.
-- Excludes expected WB champion transitions by ignoring participants that are still undefeated
-- in locked WB results (i.e., they have locked WB wins but no locked WB losses).
with fixtures(tournament_id) as (
  values
    (:'tournament_id_4'::uuid),
    (:'tournament_id_6'::uuid),
    (:'tournament_id_8'::uuid)
),
lb_participants as (
  select m.tournament_id, m.id as lb_match_id, m.round as lb_round, p.participant_id
  from public.matches m
  cross join lateral (
    values (m.home_participant_id), (m.away_participant_id)
  ) as p(participant_id)
  where m.tournament_id in (select tournament_id from fixtures)
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'LOSERS'
    and p.participant_id is not null
),
wb_locked_losses as (
  select
    m.tournament_id,
    case
      when mr.home_score > mr.away_score then m.away_participant_id
      when mr.away_score > mr.home_score then m.home_participant_id
      else null
    end as participant_id
  from public.matches m
  join public.match_results mr on mr.match_id = m.id
  where m.tournament_id in (select tournament_id from fixtures)
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and mr.locked = true
),
wb_locked_wins as (
  select
    m.tournament_id,
    case
      when mr.home_score > mr.away_score then m.home_participant_id
      when mr.away_score > mr.home_score then m.away_participant_id
      else null
    end as participant_id
  from public.matches m
  join public.match_results mr on mr.match_id = m.id
  where m.tournament_id in (select tournament_id from fixtures)
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and mr.locked = true
)
select
  lb.tournament_id,
  lb.lb_match_id,
  lb.lb_round,
  lb.participant_id as lb_participant_without_prior_wb_loss
from lb_participants lb
left join wb_locked_losses l
  on l.tournament_id = lb.tournament_id
 and l.participant_id = lb.participant_id
where l.participant_id is null
  and not exists (
    select 1
    from wb_locked_wins w
    where w.tournament_id = lb.tournament_id
      and w.participant_id = lb.participant_id
  )
order by lb.tournament_id, lb.lb_round, lb.lb_match_id;
-- Expected output: 0 rows.

-- Invariant 2: each locked WB match contributes exactly one loser mapping (idempotent trigger behavior).
with fixtures(tournament_id) as (
  values
    (:'tournament_id_4'::uuid),
    (:'tournament_id_6'::uuid),
    (:'tournament_id_8'::uuid)
)
select
  m.tournament_id,
  m.id as wb_match_id,
  count(e.source_match_id) as mapped_loser_count
from public.matches m
join public.match_results mr
  on mr.match_id = m.id
 and mr.locked = true
left join public.playoff_placement_entrants e
  on e.source_match_id = m.id
where m.tournament_id in (select tournament_id from fixtures)
  and m.stage = 'PLAYOFF'
  and m.bracket_type = 'WINNERS'
  and m.home_participant_id is not null
  and m.away_participant_id is not null
group by m.tournament_id, m.id
having count(e.source_match_id) <> 1
order by m.tournament_id, m.id;
-- Expected output: 0 rows.

-- Invariant 3: no participant is active in conflicting WB/LB matches in the same progression step.
-- Here progression step is modeled as PLAYOFF round number; active means result is not locked.
with fixtures(tournament_id) as (
  values
    (:'tournament_id_4'::uuid),
    (:'tournament_id_6'::uuid),
    (:'tournament_id_8'::uuid)
),
active_matches as (
  select
    m.tournament_id,
    m.id as match_id,
    m.bracket_type,
    m.round,
    p.participant_id
  from public.matches m
  left join public.match_results mr on mr.match_id = m.id
  cross join lateral (
    values (m.home_participant_id), (m.away_participant_id)
  ) as p(participant_id)
  where m.tournament_id in (select tournament_id from fixtures)
    and m.stage = 'PLAYOFF'
    and m.bracket_type in ('WINNERS', 'LOSERS')
    and coalesce(mr.locked, false) = false
    and p.participant_id is not null
)
select
  a.tournament_id,
  a.round as progression_step,
  a.participant_id,
  a.match_id as winners_match_id,
  b.match_id as losers_match_id
from active_matches a
join active_matches b
  on b.tournament_id = a.tournament_id
 and b.round = a.round
 and b.participant_id = a.participant_id
 and b.bracket_type = 'LOSERS'
 and a.bracket_type = 'WINNERS'
 and b.match_id <> a.match_id
order by a.tournament_id, progression_step, a.participant_id;
-- Expected output: 0 rows.
