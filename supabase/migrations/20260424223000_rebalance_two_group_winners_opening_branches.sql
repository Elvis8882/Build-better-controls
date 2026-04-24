-- Rebalance two-group playoff seeding so mirrored cross-group pairings
-- are split across opposite winners-bracket branches.
-- For two groups of four, opening matchups become:
--   1A vs 4B, 3A vs 2B, 4A vs 1B, 2A vs 3B
-- which keeps 1A-4B and 4A-1B out of the same starting branch.
create or replace view public.v_playoff_seeds
with (security_invoker = true)
as
with standings as (
  select
    s.tournament_id,
    s.group_id,
    s.participant_id,
    s.points,
    s.goal_diff,
    s.shots_diff,
    tg.group_code,
    tp.team_id,
    tp.created_at
  from public.v_group_standings s
  join public.tournament_groups tg
    on tg.id = s.group_id
  join public.tournament_participants tp
    on tp.id = s.participant_id
), ranked as (
  select
    st.*,
    row_number() over (
      partition by st.tournament_id, st.team_id
      order by st.created_at asc, st.participant_id asc
    ) as team_member_rank,
    row_number() over (
      partition by st.tournament_id, st.group_id
      order by
        st.points desc,
        st.goal_diff desc,
        st.shots_diff desc,
        st.created_at asc,
        st.participant_id asc
    ) as group_seed
  from standings st
), eligible as (
  select r.*
  from ranked r
  join public.tournaments t
    on t.id = r.tournament_id
  where
    not public.preset_is_team_based(t.preset_id)
    or (r.team_id is not null and r.team_member_rank = 1)
)
select
  e.tournament_id,
  e.participant_id,
  row_number() over (
    partition by e.tournament_id
    order by
      e.group_seed asc,
      e.group_code asc,
      e.points desc,
      e.goal_diff desc,
      e.shots_diff desc,
      e.created_at asc,
      e.participant_id asc
  )::int as seed
from eligible e;
