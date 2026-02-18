-- Fix tournament regressions:
-- 1) Avoid GROUP stage collisions with playoff-only bracket uniqueness.
-- 2) Prevent "record hp is not assigned yet" in identity sync routine.

begin;

alter table public.matches
  drop constraint if exists matches_bracket_unique;

drop index if exists public.matches_bracket_unique;

create unique index if not exists matches_playoff_bracket_unique
  on public.matches (tournament_id, stage, bracket_type, round, bracket_slot)
  where stage = 'PLAYOFF';

create or replace function public.sync_match_identities_from_participants(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  v_home_user_id uuid;
  v_home_guest_id uuid;
  v_away_user_id uuid;
  v_away_guest_id uuid;
begin
  select * into m from public.matches where id = p_match_id;

  if m.home_participant_id is not null then
    select user_id, guest_id
    into v_home_user_id, v_home_guest_id
    from public.tournament_participants
    where id = m.home_participant_id;
  end if;

  if m.away_participant_id is not null then
    select user_id, guest_id
    into v_away_user_id, v_away_guest_id
    from public.tournament_participants
    where id = m.away_participant_id;
  end if;

  update public.matches
  set
    home_user_id = v_home_user_id,
    home_guest_id = v_home_guest_id,
    away_user_id = v_away_user_id,
    away_guest_id = v_away_guest_id
  where id = p_match_id;
end;
$$;

commit;
