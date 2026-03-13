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

-- Invariant 2: each locked WB match contributes exactly one loser to its mapped LB target
-- (idempotent even if the trigger fires repeatedly for the same locked result).
with fixtures(tournament_id) as (
  values
    (:'tournament_id_4'::uuid),
    (:'tournament_id_6'::uuid),
    (:'tournament_id_8'::uuid)
),
wb_locked_decisive as (
  select
    m.tournament_id,
    m.id as wb_match_id,
    m.round as wb_round,
    greatest(coalesce(m.bracket_slot, 1), 1) as wb_slot,
    case
      when mr.home_score > mr.away_score then m.away_participant_id
      when mr.away_score > mr.home_score then m.home_participant_id
      else null
    end as loser_participant_id
  from public.matches m
  join public.match_results mr
    on mr.match_id = m.id
   and mr.locked = true
  where m.tournament_id in (select tournament_id from fixtures)
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.home_participant_id is not null
    and m.away_participant_id is not null
    and mr.home_score <> mr.away_score
),
wb_to_lb_targets as (
  select
    wb.tournament_id,
    wb.wb_match_id,
    wb.loser_participant_id,
    lb.id as lb_match_id,
    case
      when ((lb.metadata->>'wb_drop_home_round')::int) = wb.wb_round
       and ((lb.metadata->>'wb_drop_home_slot')::int) = wb.wb_slot
      then 'HOME'
      when ((lb.metadata->>'wb_drop_away_round')::int) = wb.wb_round
       and ((lb.metadata->>'wb_drop_away_slot')::int) = wb.wb_slot
      then 'AWAY'
      else null
    end as mapped_target_side,
    lb.home_participant_id,
    lb.away_participant_id
  from wb_locked_decisive wb
  left join public.matches lb
    on lb.tournament_id = wb.tournament_id
   and lb.stage = 'PLAYOFF'
   and lb.bracket_type = 'LOSERS'
   and (
     (((lb.metadata->>'wb_drop_home_round')::int) = wb.wb_round
       and ((lb.metadata->>'wb_drop_home_slot')::int) = wb.wb_slot)
     or
     (((lb.metadata->>'wb_drop_away_round')::int) = wb.wb_round
       and ((lb.metadata->>'wb_drop_away_slot')::int) = wb.wb_slot)
   )
),
target_cardinality as (
  select
    tournament_id,
    wb_match_id,
    count(lb_match_id) as mapped_target_count
  from wb_to_lb_targets
  group by tournament_id, wb_match_id
)
select
  wb.tournament_id,
  wb.wb_match_id,
  tc.mapped_target_count,
  t.lb_match_id,
  t.mapped_target_side,
  wb.loser_participant_id,
  case
    when tc.mapped_target_count <> 1 then 'TARGET_CARDINALITY_VIOLATION'
    when t.mapped_target_side = 'HOME' and t.home_participant_id is distinct from wb.loser_participant_id
      then 'LOSER_NOT_ON_MAPPED_HOME_SIDE'
    when t.mapped_target_side = 'AWAY' and t.away_participant_id is distinct from wb.loser_participant_id
      then 'LOSER_NOT_ON_MAPPED_AWAY_SIDE'
    when t.mapped_target_side is null then 'UNRESOLVED_TARGET_SIDE'
    else null
  end as violation
from wb_locked_decisive wb
join target_cardinality tc
  on tc.tournament_id = wb.tournament_id
 and tc.wb_match_id = wb.wb_match_id
left join wb_to_lb_targets t
  on t.tournament_id = wb.tournament_id
 and t.wb_match_id = wb.wb_match_id
where tc.mapped_target_count <> 1
   or (t.mapped_target_side = 'HOME' and t.home_participant_id is distinct from wb.loser_participant_id)
   or (t.mapped_target_side = 'AWAY' and t.away_participant_id is distinct from wb.loser_participant_id)
   or t.mapped_target_side is null
order by wb.tournament_id, wb.wb_match_id;
-- Expected output: 0 rows.

-- Supplemental idempotency guard: no duplicate placement rows for the same WB source match.
-- (Kept as a compatibility check for deployments still persisting playoff_placement_entrants.)
with fixtures(tournament_id) as (
  values
    (:'tournament_id_4'::uuid),
    (:'tournament_id_6'::uuid),
    (:'tournament_id_8'::uuid)
)
select
  e.tournament_id,
  e.source_match_id,
  count(*) as placement_rows_for_source_match
from public.playoff_placement_entrants e
where e.tournament_id in (select tournament_id from fixtures)
group by e.tournament_id, e.source_match_id
having count(*) > 1
order by e.tournament_id, e.source_match_id;
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
