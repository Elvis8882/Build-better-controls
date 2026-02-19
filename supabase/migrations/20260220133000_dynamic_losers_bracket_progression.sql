create or replace function public.ensure_losers_bracket(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preset text;
  v_n int;
  v_s int;
begin
  select preset_id into v_preset from public.tournaments where id = p_tournament_id;
  if v_preset is null then
    return;
  end if;

  select count(*) into v_n from public.tournament_participants where tournament_id = p_tournament_id;
  if v_n < 4 then
    return;
  end if;

  v_s := 1;
  while v_s < v_n loop v_s := v_s * 2; end loop;

  if v_preset <> 'full_with_losers' then
    insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
    select p_tournament_id, 'PLAYOFF', 'LOSERS', 1, 1
    where not exists (
      select 1
      from public.matches mx
      where mx.tournament_id = p_tournament_id
        and mx.stage = 'PLAYOFF'
        and mx.bracket_type = 'LOSERS'
        and mx.round = 1
        and mx.bracket_slot = 1
    );
  end if;
end;
$$;

create or replace function public.trg_advance_playoff_winner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  winner uuid;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'PLAYOFF' then
    return new;
  end if;

  if new.home_score > new.away_score then
    winner := m.home_participant_id;
  elsif new.away_score > new.home_score then
    winner := m.away_participant_id;
  else
    return new;
  end if;

  if m.next_match_id is null or m.next_match_side is null then
    return new;
  end if;

  if m.next_match_side = 'HOME' then
    update public.matches set home_participant_id = winner where id = m.next_match_id;
  else
    update public.matches set away_participant_id = winner where id = m.next_match_id;
  end if;

  perform public.sync_match_identities_from_participants(m.next_match_id);
  return new;
end;
$$;

create or replace function public.trg_place_losers_into_losers_bracket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  loser uuid;
  target uuid;
  v_preset text;
  v_max_round int;
  v_quarter_round int;
  v_semifinal_round int;
  v_group_slot int;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'PLAYOFF' or m.bracket_type <> 'WINNERS' then
    return new;
  end if;

  select preset_id into v_preset from public.tournaments where id = m.tournament_id;
  if v_preset is null then
    return new;
  end if;

  if new.home_score > new.away_score then
    loser := m.away_participant_id;
  elsif new.away_score > new.home_score then
    loser := m.home_participant_id;
  else
    return new;
  end if;

  if loser is null then
    return new;
  end if;

  select coalesce(max(round), 1) into v_max_round
  from public.matches
  where tournament_id = m.tournament_id
    and stage = 'PLAYOFF'
    and bracket_type = 'WINNERS';

  v_semifinal_round := greatest(v_max_round - 1, 1);
  v_quarter_round := greatest(v_max_round - 2, 1);

  if v_preset = 'full_with_losers' and v_max_round >= 3 then
    if m.round = v_quarter_round then
      v_group_slot := ceil(coalesce(m.bracket_slot, 1) / 2.0)::int;

      insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
      select m.tournament_id, 'PLAYOFF', 'LOSERS', 1, v_group_slot
      where not exists (
        select 1 from public.matches mx
        where mx.tournament_id = m.tournament_id
          and mx.stage = 'PLAYOFF'
          and mx.bracket_type = 'LOSERS'
          and mx.round = 1
          and mx.bracket_slot = v_group_slot
      );

      insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
      select m.tournament_id, 'PLAYOFF', 'LOSERS', 2, v_group_slot
      where not exists (
        select 1 from public.matches mx
        where mx.tournament_id = m.tournament_id
          and mx.stage = 'PLAYOFF'
          and mx.bracket_type = 'LOSERS'
          and mx.round = 2
          and mx.bracket_slot = v_group_slot
      );

      update public.matches
      set next_match_id = (
            select id from public.matches
            where tournament_id = m.tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=2 and bracket_slot=v_group_slot
          ),
          next_match_side = 'AWAY'
      where tournament_id = m.tournament_id
        and stage='PLAYOFF'
        and bracket_type='LOSERS'
        and round=1
        and bracket_slot=v_group_slot;

      select id into target
      from public.matches
      where tournament_id = m.tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
        and round=1 and bracket_slot=v_group_slot;

      update public.matches
      set home_participant_id = coalesce(home_participant_id, loser),
          away_participant_id = case when home_participant_id is not null and away_participant_id is null then loser else away_participant_id end
      where id = target;

      perform public.sync_match_identities_from_participants(target);
      return new;
    end if;

    if m.round = v_semifinal_round then
      v_group_slot := coalesce(m.bracket_slot, 1);

      insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
      select m.tournament_id, 'PLAYOFF', 'LOSERS', 2, v_group_slot
      where not exists (
        select 1 from public.matches mx
        where mx.tournament_id = m.tournament_id
          and mx.stage = 'PLAYOFF'
          and mx.bracket_type = 'LOSERS'
          and mx.round = 2
          and mx.bracket_slot = v_group_slot
      );

      insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
      select m.tournament_id, 'PLAYOFF', 'LOSERS', 3, 1
      where not exists (
        select 1 from public.matches mx
        where mx.tournament_id = m.tournament_id
          and mx.stage = 'PLAYOFF'
          and mx.bracket_type = 'LOSERS'
          and mx.round = 3
          and mx.bracket_slot = 1
      );

      update public.matches
      set next_match_id = (
            select id from public.matches
            where tournament_id = m.tournament_id and stage='PLAYOFF' and bracket_type='LOSERS' and round=3 and bracket_slot=1
          ),
          next_match_side = case when bracket_slot = 1 then 'HOME' else 'AWAY' end
      where tournament_id = m.tournament_id
        and stage='PLAYOFF'
        and bracket_type='LOSERS'
        and round=2
        and bracket_slot in (1,2);

      select id into target
      from public.matches
      where tournament_id = m.tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
        and round=2 and bracket_slot=v_group_slot;

      update public.matches
      set home_participant_id = coalesce(home_participant_id, loser),
          away_participant_id = case when home_participant_id is not null and away_participant_id is null then loser else away_participant_id end
      where id = target;

      perform public.sync_match_identities_from_participants(target);
      return new;
    end if;

    return new;
  end if;

  perform public.ensure_losers_bracket(m.tournament_id);

  if m.round = v_semifinal_round then
    select id into target
    from public.matches
    where tournament_id = m.tournament_id and stage='PLAYOFF' and bracket_type='LOSERS'
      and round=1 and bracket_slot=1;

    if target is not null then
      update public.matches
      set home_participant_id = coalesce(home_participant_id, loser),
          away_participant_id = case when home_participant_id is not null and away_participant_id is null then loser else away_participant_id end
      where id = target;

      perform public.sync_match_identities_from_participants(target);
    end if;
  end if;

  return new;
end;
$$;
