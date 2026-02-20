create table if not exists public.playoff_placement_entrants (
  id bigserial primary key,
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  participant_id uuid not null references public.tournament_participants(id) on delete cascade,
  source_match_id uuid not null references public.matches(id) on delete cascade,
  source_round int not null,
  source_slot int not null,
  source_stage text not null check (source_stage in ('QF', 'SF')),
  source_group_slot int,
  created_at timestamptz not null default now(),
  unique (source_match_id, participant_id),
  unique (tournament_id, participant_id)
);

create index if not exists idx_playoff_placement_entrants_tournament_stage_group
  on public.playoff_placement_entrants(tournament_id, source_stage, source_group_slot);

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
  v_source_stage text;
  v_round1_match_id uuid;
  v_round2_match_id uuid;
  v_round3_match_id uuid;
  v_home uuid;
  v_away uuid;
  v_count int;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'PLAYOFF' or m.bracket_type <> 'WINNERS' then
    return new;
  end if;

  -- BYE/auto-advance path: no real game means no loser should ever be added to placement.
  if m.home_participant_id is null or m.away_participant_id is null then
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
  v_source_stage := null;

  if m.round = v_quarter_round and v_max_round >= 3 then
    v_source_stage := 'QF';
    v_group_slot := ceil(coalesce(m.bracket_slot, 1) / 2.0)::int;
  elsif m.round = v_semifinal_round then
    v_source_stage := 'SF';
    v_group_slot := coalesce(m.bracket_slot, 1);
  end if;

  if v_source_stage is null then
    return new;
  end if;

  -- Idempotent loser ingestion: same source match loser can be processed multiple times safely.
  insert into public.playoff_placement_entrants(
    tournament_id,
    participant_id,
    source_match_id,
    source_round,
    source_slot,
    source_stage,
    source_group_slot
  )
  values (
    m.tournament_id,
    loser,
    m.id,
    m.round,
    coalesce(m.bracket_slot, 1),
    v_source_stage,
    v_group_slot
  )
  on conflict (source_match_id, participant_id) do nothing;

  -- full_with_losers: build placement graph only when real entrants exist.
  if v_preset = 'full_with_losers' and v_max_round >= 3 then
    if v_source_stage = 'QF' then
      select count(*) into v_count
      from public.playoff_placement_entrants e
      where e.tournament_id = m.tournament_id
        and e.source_stage = 'QF'
        and e.source_group_slot = v_group_slot;

      -- Do not create dangling placement QF nodes when only one actual loser exists.
      if v_count < 2 then
        return new;
      end if;

      select e.participant_id into v_home
      from public.playoff_placement_entrants e
      where e.tournament_id = m.tournament_id
        and e.source_stage = 'QF'
        and e.source_group_slot = v_group_slot
      order by e.created_at asc, e.id asc
      limit 1;

      select e.participant_id into v_away
      from public.playoff_placement_entrants e
      where e.tournament_id = m.tournament_id
        and e.source_stage = 'QF'
        and e.source_group_slot = v_group_slot
      order by e.created_at asc, e.id asc
      offset 1
      limit 1;

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

      select id into v_round1_match_id
      from public.matches
      where tournament_id = m.tournament_id
        and stage = 'PLAYOFF'
        and bracket_type = 'LOSERS'
        and round = 1
        and bracket_slot = v_group_slot;

      select id into v_round2_match_id
      from public.matches
      where tournament_id = m.tournament_id
        and stage = 'PLAYOFF'
        and bracket_type = 'LOSERS'
        and round = 2
        and bracket_slot = v_group_slot;

      update public.matches
      set next_match_id = v_round2_match_id,
          next_match_side = 'AWAY'
      where id = v_round1_match_id;

      update public.matches
      set home_participant_id = v_home,
          away_participant_id = v_away
      where id = v_round1_match_id;

      perform public.sync_match_identities_from_participants(v_round1_match_id);
      perform public.sync_match_identities_from_participants(v_round2_match_id);
      return new;
    end if;

    if v_source_stage = 'SF' then
      select e.participant_id into v_home
      from public.playoff_placement_entrants e
      where e.tournament_id = m.tournament_id
        and e.source_stage = 'SF'
        and e.source_group_slot = v_group_slot
      order by e.created_at asc, e.id asc
      limit 1;

      if v_home is null then
        return new;
      end if;

      select id into v_round1_match_id
      from public.matches
      where tournament_id = m.tournament_id
        and stage = 'PLAYOFF'
        and bracket_type = 'LOSERS'
        and round = 1
        and bracket_slot = v_group_slot;

      if v_round1_match_id is null then
        -- No valid placement QF happened for this side (odd-N / BYE path): wait, do not create dangling round-2.
        return new;
      end if;

      select case
               when mr.home_score > mr.away_score then rm.home_participant_id
               when mr.away_score > mr.home_score then rm.away_participant_id
               else null
             end
      into v_away
      from public.matches rm
      join public.match_results mr on mr.match_id = rm.id
      where rm.id = v_round1_match_id
        and mr.locked = true;

      if v_away is null then
        -- We only populate once both real entrants are known.
        return new;
      end if;

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

      select id into v_round2_match_id
      from public.matches
      where tournament_id = m.tournament_id
        and stage = 'PLAYOFF'
        and bracket_type = 'LOSERS'
        and round = 2
        and bracket_slot = v_group_slot;

      update public.matches
      set home_participant_id = v_home,
          away_participant_id = v_away
      where id = v_round2_match_id;

      perform public.sync_match_identities_from_participants(v_round2_match_id);

      -- Create 3rd-place final only when both real semi-side placement finals exist.
      if exists (
        select 1
        from public.matches mx
        join public.match_results mr on mr.match_id = mx.id
        where mx.tournament_id = m.tournament_id
          and mx.stage = 'PLAYOFF'
          and mx.bracket_type = 'LOSERS'
          and mx.round = 2
          and mx.bracket_slot in (1, 2)
          and mr.locked = true
        group by mx.tournament_id
        having count(*) = 2
      ) then
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

        select id into v_round3_match_id
        from public.matches
        where tournament_id = m.tournament_id
          and stage = 'PLAYOFF'
          and bracket_type = 'LOSERS'
          and round = 3
          and bracket_slot = 1;

        update public.matches
        set next_match_id = v_round3_match_id,
            next_match_side = case when bracket_slot = 1 then 'HOME' else 'AWAY' end
        where tournament_id = m.tournament_id
          and stage = 'PLAYOFF'
          and bracket_type = 'LOSERS'
          and round = 2
          and bracket_slot in (1,2);
      end if;

      return new;
    end if;

    return new;
  end if;

  -- full_no_losers / playoffs_only: 3rd-place shell can exist, but fill only when both actual semifinal losers exist.
  perform public.ensure_losers_bracket(m.tournament_id);

  if v_source_stage = 'SF' then
    select count(*) into v_count
    from public.playoff_placement_entrants e
    where e.tournament_id = m.tournament_id
      and e.source_stage = 'SF';

    if v_count < 2 then
      return new;
    end if;

    select e.participant_id into v_home
    from public.playoff_placement_entrants e
    where e.tournament_id = m.tournament_id
      and e.source_stage = 'SF'
    order by e.source_slot asc, e.created_at asc, e.id asc
    limit 1;

    select e.participant_id into v_away
    from public.playoff_placement_entrants e
    where e.tournament_id = m.tournament_id
      and e.source_stage = 'SF'
    order by e.source_slot asc, e.created_at asc, e.id asc
    offset 1
    limit 1;

    select id into target
    from public.matches
    where tournament_id = m.tournament_id
      and stage = 'PLAYOFF'
      and bracket_type = 'LOSERS'
      and round = 1
      and bracket_slot = 1;

    if target is not null then
      update public.matches
      set home_participant_id = v_home,
          away_participant_id = v_away
      where id = target;

      perform public.sync_match_identities_from_participants(target);
    end if;
  end if;

  return new;
end;
$$;
