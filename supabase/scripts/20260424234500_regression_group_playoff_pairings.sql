-- Regression checks for deterministic group-stage playoff pairings in ensure_playoff_bracket.
--
-- Usage:
--  - Prepare fixtures and run: select public.ensure_playoff_bracket(<tournament_id>);
--  - Replace the psql variables below with fixture tournament IDs.
--
-- Required fixtures:
--   :tournament_id_1g8  -> 1 group, 8 qualified participants
--   :tournament_id_2g8  -> 2 groups, 8 qualified participants (4 per group)
--   :tournament_id_3g   -> 3+ groups (any supported qualified size)
--   :tournament_id_2g6  -> 2 groups, 6 qualified participants
--   :tournament_id_2g5  -> 2 groups, 5 qualified participants

-- =====================================================================
-- Scenario 1: 1 group x 8 participants => 1v8, 2v7, 3v6, 4v5
-- =====================================================================
with ranked as (
  select
    ps.seed,
    ps.participant_id
  from public.v_playoff_seeds ps
  where ps.tournament_id = :'tournament_id_1g8'::uuid
), expected as (
  select 1 as bracket_slot,
         (select participant_id from ranked where seed = 1) as home_participant_id,
         (select participant_id from ranked where seed = 8) as away_participant_id
  union all
  select 2,
         (select participant_id from ranked where seed = 2),
         (select participant_id from ranked where seed = 7)
  union all
  select 3,
         (select participant_id from ranked where seed = 3),
         (select participant_id from ranked where seed = 6)
  union all
  select 4,
         (select participant_id from ranked where seed = 4),
         (select participant_id from ranked where seed = 5)
)
select
  m.bracket_slot,
  m.home_participant_id,
  m.away_participant_id,
  e.home_participant_id as expected_home,
  e.away_participant_id as expected_away
from public.matches m
join expected e
  on e.bracket_slot = m.bracket_slot
where m.tournament_id = :'tournament_id_1g8'::uuid
  and m.stage = 'PLAYOFF'
  and m.bracket_type = 'WINNERS'
  and m.round = 1
  and (
    m.home_participant_id is distinct from e.home_participant_id
    or m.away_participant_id is distinct from e.away_participant_id
  );
-- Expected output: 0 rows.

-- =====================================================================
-- Scenario 2: 2 groups x 8 participants => 1Av4B, 2Av3B, 3Av2B, 4Av1B,
--             and mirrored rank matchups split across opposite branches.
-- =====================================================================
with grouped as (
  select
    ps.seed,
    ps.participant_id,
    tg.group_code,
    row_number() over (
      partition by tg.id
      order by ps.seed asc, ps.participant_id asc
    )::int as group_rank
  from public.v_playoff_seeds ps
  join public.tournament_group_members tgm
    on tgm.participant_id = ps.participant_id
  join public.tournament_groups tg
    on tg.id = tgm.group_id
  where ps.tournament_id = :'tournament_id_2g8'::uuid
), groups as (
  select group_code
  from grouped
  group by group_code
  order by group_code asc
  limit 2
), g1 as (
  select group_code from groups order by group_code asc limit 1
), g2 as (
  select group_code from groups order by group_code asc offset 1 limit 1
), expected as (
  select
    r as pair_rank,
    (select participant_id from grouped where group_code = (select group_code from g1) and group_rank = r) as expected_home,
    (select participant_id from grouped where group_code = (select group_code from g2) and group_rank = (5 - r)) as expected_away
  from generate_series(1, 4) as r
), observed as (
  select
    m.bracket_slot,
    m.home_participant_id,
    m.away_participant_id,
    row_number() over (order by m.bracket_slot asc)::int as pair_rank
  from public.matches m
  where m.tournament_id = :'tournament_id_2g8'::uuid
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.round = 1
), pair_check as (
  select
    o.bracket_slot,
    o.home_participant_id,
    o.away_participant_id,
    e.expected_home,
    e.expected_away
  from observed o
  join expected e
    on e.pair_rank = o.pair_rank
  where o.home_participant_id is distinct from e.expected_home
     or o.away_participant_id is distinct from e.expected_away
), mirrored_branch_check as (
  select
    o1.bracket_slot as slot_left,
    o2.bracket_slot as slot_right
  from observed o1
  join observed o2
    on o1.pair_rank + o2.pair_rank = 5
  where (case when o1.bracket_slot <= 2 then 1 else 2 end)
      = (case when o2.bracket_slot <= 2 then 1 else 2 end)
)
select * from pair_check
union all
select
  mb.slot_left,
  null::uuid,
  null::uuid,
  null::uuid,
  null::uuid
from mirrored_branch_check mb;
-- Expected output: 0 rows.

-- =====================================================================
-- Scenario 3: 3+ groups => no same-group R1 pairing unless unavoidable.
-- =====================================================================
with group_sizes as (
  select tgm.group_id, count(*)::int as members
  from public.tournament_group_members tgm
  join public.tournament_participants tp
    on tp.id = tgm.participant_id
  where tp.tournament_id = :'tournament_id_3g'::uuid
  group by tgm.group_id
), unavoidable as (
  -- Same-group pairings are unavoidable only if one group has more than half
  -- of all qualified participants in the playoff field.
  select (max(gs.members) > (sum(gs.members) / 2.0)) as is_unavoidable
  from group_sizes gs
), r1 as (
  select
    m.bracket_slot,
    hg.group_id as home_group_id,
    ag.group_id as away_group_id
  from public.matches m
  left join public.tournament_group_members hg
    on hg.participant_id = m.home_participant_id
  left join public.tournament_group_members ag
    on ag.participant_id = m.away_participant_id
  where m.tournament_id = :'tournament_id_3g'::uuid
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.round = 1
    and m.home_participant_id is not null
    and m.away_participant_id is not null
)
select
  r1.bracket_slot,
  r1.home_group_id,
  r1.away_group_id
from r1
cross join unavoidable u
where r1.home_group_id = r1.away_group_id
  and not u.is_unavoidable;
-- Expected output: 0 rows.


-- =====================================================================
-- Scenario 4: 2 groups x 6 participants => canonical 8-slot R1 occupancy
--             (2 BYE matches, 2 full matches) and 4 semifinal participants.
-- =====================================================================
with r1 as (
  select
    m.bracket_slot,
    m.home_participant_id,
    m.away_participant_id
  from public.matches m
  where m.tournament_id = :'tournament_id_2g6'::uuid
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.round = 1
), sf as (
  select
    m.bracket_slot,
    m.home_participant_id,
    m.away_participant_id
  from public.matches m
  where m.tournament_id = :'tournament_id_2g6'::uuid
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.round = 2
), agg as (
  select
    (select count(*) from r1 where (home_participant_id is null) <> (away_participant_id is null)) as bye_matches,
    (select count(*) from r1 where home_participant_id is not null and away_participant_id is not null) as full_matches,
    (select count(*) from sf where home_participant_id is not null)
      + (select count(*) from sf where away_participant_id is not null) as semifinal_participants
)
select *
from agg
where bye_matches <> 2
   or full_matches <> 2
   or semifinal_participants <> 4;
-- Expected output: 0 rows.

-- =====================================================================
-- Scenario 5: 2 groups x 5 participants => canonical 8-slot R1 occupancy
--             (3 BYE matches, 1 full match) and 4 semifinal participants.
-- =====================================================================
with r1 as (
  select
    m.bracket_slot,
    m.home_participant_id,
    m.away_participant_id
  from public.matches m
  where m.tournament_id = :'tournament_id_2g5'::uuid
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.round = 1
), sf as (
  select
    m.bracket_slot,
    m.home_participant_id,
    m.away_participant_id
  from public.matches m
  where m.tournament_id = :'tournament_id_2g5'::uuid
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and m.round = 2
), agg as (
  select
    (select count(*) from r1 where (home_participant_id is null) <> (away_participant_id is null)) as bye_matches,
    (select count(*) from r1 where home_participant_id is not null and away_participant_id is not null) as full_matches,
    (select count(*) from sf where home_participant_id is not null)
      + (select count(*) from sf where away_participant_id is not null) as semifinal_participants
)
select *
from agg
where bye_matches <> 3
   or full_matches <> 1
   or semifinal_participants <> 4;
-- Expected output: 0 rows.
