-- Preserve placement BYE nodes and their source rounds. Locked brackets are not rebuilt.

create or replace function public.ensure_playoff_bracket(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
	r record;
  v_preset text;
  v_status text;
  v_n int;
  v_s int;
  v_rounds int;
  v_round int;
  v_slot int;
  v_matches_in_round int;
  v_seeded uuid[];
  v_has_group boolean;
  v_any_playoff_locked boolean;
  v_mid uuid;
  v_parent uuid;
  v_parent_side text;
  v_home uuid;
  v_away uuid;
  v_seed_positions int[];
  v_next_positions int[];
  v_pos int;
  v_team_based boolean := false;
  v_is_full_with_losers boolean := false;
  v_leaf_alive int[];
  v_next_alive int[];
  v_drop_side text;
  v_group_count int := 0;
  v_group_a uuid;
  v_group_b uuid;
  v_max_group_rank int := 0;
  v_rank int;
  v_anchor_seed int;
  v_anchor_participant uuid;
  v_anchor_group uuid;
  v_opponent_participant uuid;
  v_opponent_group uuid;
  v_order_seed int;
  v_slot_branch int;
  v_assigned_refs int;
  v_distinct_assigned int;
  v_expected_null_null_slots int;
  v_actual_null_null_slots int;
  v_seed uuid;
  v_seed_occurrences int;
  v_expected_home uuid;
  v_expected_away uuid;
  v_tokens jsonb[];
  v_next_tokens jsonb[];
  v_drops jsonb[];
  v_sources jsonb[];
  v_token jsonb;
  v_phase int;
  v_pair_count int;
  v_side_index int;
  v_display_round int;
  v_round_label text;
begin
  -- Developer note:
  -- Group Stage qualification/seeding flow is intentionally preserved.
  -- Full-with-losers placement supports 3..16 entrants. Build it after seeding
  -- so source occupancy reflects the actual group-specific winners layout.

  select preset_id, status, public.preset_is_team_based(preset_id), public.preset_is_full_with_losers(preset_id)
  into v_preset, v_status, v_team_based, v_is_full_with_losers
  from public.tournaments
  where id = p_tournament_id;

  if lower(coalesce(v_status, '')) = 'closed' then
    raise exception 'Cannot modify playoff bracket for closed tournament'
      using errcode = '55000';
  end if;

  select exists (
    select 1
    from public.matches m
    join public.match_results mr on mr.match_id = m.id
    where m.tournament_id = p_tournament_id
      and m.stage = 'PLAYOFF'
      and mr.locked = true
  ) into v_any_playoff_locked;

  -- Freeze playoff bracket structure and participant assignments once any playoff result is locked.
  if v_any_playoff_locked then
    return;
  end if;

  if v_team_based then
    select count(*) into v_n
    from (
      select distinct on (tp.team_id) tp.id
      from public.tournament_participants tp
      where tp.tournament_id = p_tournament_id
        and tp.team_id is not null
      order by tp.team_id, tp.created_at asc, tp.id asc
    ) seeded;
  else
    select count(*) into v_n
    from public.tournament_participants
    where tournament_id = p_tournament_id;
  end if;

  if v_n < 3 then
    return;
  end if;

  v_s := 1;
  while v_s < v_n loop v_s := v_s * 2; end loop;
  v_rounds := (log(v_s)::numeric / log(2)::numeric)::int;

  -- Ensure winners-bracket graph exists for all playoff-capable presets.
  -- Non-full-with-losers modes depend on this graph for normal single-elim flow.
  for v_round in 1..v_rounds loop
    v_matches_in_round := v_s / (2^v_round);
    for v_slot in 1..v_matches_in_round loop
      insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
      select p_tournament_id, 'PLAYOFF', 'WINNERS', v_round, v_slot
      where not exists (
        select 1
        from public.matches mx
        where mx.tournament_id = p_tournament_id
          and mx.stage = 'PLAYOFF'
          and mx.bracket_type = 'WINNERS'
          and mx.round = v_round
          and mx.bracket_slot = v_slot
      );
    end loop;
  end loop;

  -- Prune stale winners rows from previously larger brackets before relinking
  -- and validating round-1 population.
  delete from public.matches m
  where m.tournament_id = p_tournament_id
    and m.stage = 'PLAYOFF'
    and m.bracket_type = 'WINNERS'
    and (
      m.round is null
      or m.round < 1
      or m.round > v_rounds
      or m.bracket_slot is null
      or m.bracket_slot < 1
      or m.bracket_slot > (v_s / (2^m.round))
    );

  -- Keep only one winners match row per structural slot.
  -- Historical data may contain duplicate (round, bracket_slot) rows, which can
  -- inflate round-1 assignment validation counts (assigned_refs > participant_count).
  delete from public.matches m
  using (
    select id
    from (
      select
        mx.id,
        row_number() over (
          partition by mx.round, mx.bracket_slot
          order by mx.id asc
        ) as rn
      from public.matches mx
      where mx.tournament_id = p_tournament_id
        and mx.stage = 'PLAYOFF'
        and mx.bracket_type = 'WINNERS'
    ) ranked
    where ranked.rn > 1
  ) dup
  where m.id = dup.id;

  for v_round in 1..(v_rounds-1) loop
    v_matches_in_round := v_s / (2^v_round);
    for v_slot in 1..v_matches_in_round loop
      select id into v_mid
      from public.matches
      where tournament_id = p_tournament_id
        and stage='PLAYOFF' and bracket_type='WINNERS'
        and round=v_round and bracket_slot=v_slot;

      select id into v_parent
      from public.matches
      where tournament_id = p_tournament_id
        and stage='PLAYOFF' and bracket_type='WINNERS'
        and round=(v_round+1) and bracket_slot=ceil(v_slot/2.0)::int;

      v_parent_side := case when (v_slot % 2)=1 then 'HOME' else 'AWAY' end;

      update public.matches
      set next_match_id = v_parent,
          next_match_side = v_parent_side
      where id = v_mid;
    end loop;
  end loop;


  select exists (
    select 1
    from public.tournament_groups
    where tournament_id = p_tournament_id
  ) into v_has_group;

  if v_has_group then
    select array_agg(participant_id order by seed asc) into v_seeded
    from public.v_playoff_seeds
    where tournament_id = p_tournament_id;
  else
    if not exists (select 1 from public.tournament_playoff_seeds where tournament_id = p_tournament_id) then
      if v_team_based then
        insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
        select p_tournament_id,
               row_number() over (order by random())::int as seed,
               id
        from (
          select distinct on (tp.team_id) tp.id
          from public.tournament_participants tp
          where tp.tournament_id = p_tournament_id
            and tp.team_id is not null
          order by tp.team_id, tp.created_at asc, tp.id asc
        ) seeded;
      else
        insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
        select p_tournament_id,
               row_number() over (order by random())::int as seed,
               id
        from public.tournament_participants
        where tournament_id = p_tournament_id;
      end if;
    end if;

    if (select count(*) from public.tournament_playoff_seeds where tournament_id = p_tournament_id) <> v_n then
      delete from public.tournament_playoff_seeds where tournament_id = p_tournament_id;
      if v_team_based then
        insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
        select p_tournament_id,
               row_number() over (order by random())::int as seed,
               id
        from (
          select distinct on (tp.team_id) tp.id
          from public.tournament_participants tp
          where tp.tournament_id = p_tournament_id
            and tp.team_id is not null
          order by tp.team_id, tp.created_at asc, tp.id asc
        ) seeded;
      else
        insert into public.tournament_playoff_seeds(tournament_id, seed, participant_id)
        select p_tournament_id,
               row_number() over (order by random())::int as seed,
               id
        from public.tournament_participants
        where tournament_id = p_tournament_id;
      end if;
    end if;

    select array_agg(participant_id order by seed asc) into v_seeded
    from public.tournament_playoff_seeds
    where tournament_id = p_tournament_id;
  end if;

  if v_seeded is null then
    return;
  end if;

  v_matches_in_round := v_s / 2;
  if v_has_group then
    drop table if exists tmp_group_ranked;
    create temporary table tmp_group_ranked (
      seed int not null,
      participant_id uuid not null,
      group_id uuid not null,
      group_code text not null,
      group_rank int not null
    ) on commit drop;

    drop table if exists tmp_r1_pairs;
    create temporary table tmp_r1_pairs (
      bracket_slot int primary key,
      home_participant_id uuid,
      away_participant_id uuid
    ) on commit drop;

    insert into tmp_group_ranked(seed, participant_id, group_id, group_code, group_rank)
    with seeded as (
      select
        ps.seed,
        ps.participant_id,
        tg.id as group_id,
        tg.group_code
      from public.v_playoff_seeds ps
      join public.tournament_group_members tgm
        on tgm.participant_id = ps.participant_id
      join public.tournament_groups tg
        on tg.id = tgm.group_id
      where ps.tournament_id = p_tournament_id
    )
    select
      s.seed,
      s.participant_id,
      s.group_id,
      s.group_code,
      row_number() over (
        partition by s.group_id
        order by s.seed asc, s.participant_id asc
      )::int as group_rank
    from seeded s;

    select count(distinct group_id) into v_group_count
    from tmp_group_ranked;

    if v_group_count = 1 then
      -- Single-group playoffs should still use canonical seed-tree placement so
      -- odd-size BYEs are granted to strongest ranks first (rank #1, then #2, ...).
      v_seed_positions := array[1, 2];
      while array_length(v_seed_positions, 1) < v_s loop
        v_next_positions := '{}'::int[];
        foreach v_pos in array v_seed_positions loop
          v_next_positions := array_append(v_next_positions, v_pos);
          v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
        end loop;
        v_seed_positions := v_next_positions;
      end loop;

      for v_slot in 1..v_matches_in_round loop
        insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
        values (
          v_slot,
          (
            select gr.participant_id
            from tmp_group_ranked gr
            where gr.seed = v_seed_positions[(v_slot - 1) * 2 + 1]
          ),
          case
            when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then (
              select gr.participant_id
              from tmp_group_ranked gr
              where gr.seed = v_seed_positions[(v_slot - 1) * 2 + 2]
            )
            else null
          end
        );
      end loop;
    elsif v_group_count = 2 then
      select grp.group_id into v_group_a
      from (
        select group_id, min(group_code) as group_code
        from tmp_group_ranked
        group by group_id
      ) grp
      order by grp.group_code asc, grp.group_id asc
      limit 1;

      select grp.group_id into v_group_b
      from (
        select group_id, min(group_code) as group_code
        from tmp_group_ranked
        where group_id <> v_group_a
        group by group_id
      ) grp
      order by grp.group_code asc, grp.group_id asc
      limit 1;

      select greatest(
        coalesce((select max(group_rank) from tmp_group_ranked where group_id = v_group_a), 0),
        coalesce((select max(group_rank) from tmp_group_ranked where group_id = v_group_b), 0)
      ) into v_max_group_rank;

      if v_n < 7 then
        -- For 5/6 qualifiers we keep the normalized-tree slot shape so top seeds
        -- receive round-1 BYEs in the canonical 8-slot bracket layout.
        v_seed_positions := array[1, 2];
        while array_length(v_seed_positions, 1) < v_s loop
          v_next_positions := '{}'::int[];
          foreach v_pos in array v_seed_positions loop
            v_next_positions := array_append(v_next_positions, v_pos);
            v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
          end loop;
          v_seed_positions := v_next_positions;
        end loop;

        for v_slot in 1..v_matches_in_round loop
          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (
            v_slot,
            (
              select gr.participant_id
              from tmp_group_ranked gr
              where gr.seed = v_seed_positions[(v_slot - 1) * 2 + 1]
            ),
            case
              when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then (
                select gr.participant_id
                from tmp_group_ranked gr
                where gr.seed = v_seed_positions[(v_slot - 1) * 2 + 2]
              )
              else null
            end
          );
        end loop;
      elsif v_s = 16 then
        -- For normalized 16-slot brackets (9..16 qualifiers), always materialize
        -- all structural round-1 slots and encode BYEs as one-sided matches.
        --
        -- Build a full ordered seed list across both groups without truncating at
        -- any specific rank, then project it through canonical seed-tree positions.
        select array_agg(x.participant_id order by x.group_rank asc, x.group_order asc) into v_seeded
        from (
          select
            gr.participant_id,
            gr.group_rank,
            case when gr.group_id = v_group_a then 1 else 2 end as group_order
          from tmp_group_ranked gr
          where gr.group_id in (v_group_a, v_group_b)
        ) x;

        v_seed_positions := array[1, 2];
        while array_length(v_seed_positions, 1) < v_s loop
          v_next_positions := '{}'::int[];
          foreach v_pos in array v_seed_positions loop
            v_next_positions := array_append(v_next_positions, v_pos);
            v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
          end loop;
          v_seed_positions := v_next_positions;
        end loop;

        for v_slot in 1..v_matches_in_round loop
          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (
            v_slot,
            case
              when v_seed_positions[(v_slot - 1) * 2 + 1] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 1]]
              else null
            end,
            case
              when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 2]]
              else null
            end
          );
        end loop;
      else
        for v_rank in 1..v_max_group_rank loop
          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (
            v_rank,
            (select participant_id from tmp_group_ranked where group_id = v_group_a and group_rank = v_rank),
            (select participant_id from tmp_group_ranked where group_id = v_group_b and group_rank = (v_max_group_rank + 1 - v_rank))
          );
        end loop;
      end if;
    else
      drop table if exists tmp_unpaired_pool;
      create temporary table tmp_unpaired_pool (
        seed int primary key,
        participant_id uuid not null,
        group_id uuid not null
      ) on commit drop;

      insert into tmp_unpaired_pool(seed, participant_id, group_id)
      select seed, participant_id, group_id
      from tmp_group_ranked
      order by seed asc;

      if v_s = 16 then
        drop table if exists tmp_ordered_participants;
        create temporary table tmp_ordered_participants (
          seed int primary key,
          participant_id uuid not null,
          group_id uuid not null
        ) on commit drop;

        v_slot := 1;
        v_order_seed := 1;
        while exists (select 1 from tmp_unpaired_pool) loop
          select seed, participant_id, group_id
          into v_anchor_seed, v_anchor_participant, v_anchor_group
          from tmp_unpaired_pool
          order by seed asc
          limit 1;

          delete from tmp_unpaired_pool where seed = v_anchor_seed;

          insert into tmp_ordered_participants(seed, participant_id, group_id)
          values (v_order_seed, v_anchor_participant, v_anchor_group);
          v_order_seed := v_order_seed + 1;

          v_opponent_participant := null;
          v_opponent_group := null;
          if exists (select 1 from tmp_unpaired_pool) then
            v_slot_branch := case when v_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end;

            select cand.participant_id, cand.group_id
            into v_opponent_participant, v_opponent_group
            from tmp_unpaired_pool cand
            left join lateral (
              select count(*)::int as branch_group_count
              from tmp_r1_pairs p
              join tmp_group_ranked grh
                on grh.participant_id = p.home_participant_id
              where (case when p.bracket_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end) = v_slot_branch
                and grh.group_id = cand.group_id
            ) h on true
            left join lateral (
              select count(*)::int as branch_group_count
              from tmp_r1_pairs p
              join tmp_group_ranked gra
                on gra.participant_id = p.away_participant_id
              where (case when p.bracket_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end) = v_slot_branch
                and gra.group_id = cand.group_id
            ) a on true
            order by
              case when cand.group_id = v_anchor_group then 1 else 0 end asc,
              (coalesce(h.branch_group_count, 0) + coalesce(a.branch_group_count, 0)) asc,
              cand.seed desc,
              cand.participant_id asc
            limit 1;

            delete from tmp_unpaired_pool where participant_id = v_opponent_participant;

            insert into tmp_ordered_participants(seed, participant_id, group_id)
            values (v_order_seed, v_opponent_participant, v_opponent_group);
            v_order_seed := v_order_seed + 1;
          end if;

          -- Keep tie-break diversity accounting on real pair selections only.
          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (v_slot, v_anchor_participant, v_opponent_participant)
          on conflict (bracket_slot) do update
            set home_participant_id = excluded.home_participant_id,
                away_participant_id = excluded.away_participant_id;

          v_slot := v_slot + 1;
        end loop;

        v_seed_positions := array[1, 2];
        while array_length(v_seed_positions, 1) < v_s loop
          v_next_positions := '{}'::int[];
          foreach v_pos in array v_seed_positions loop
            v_next_positions := array_append(v_next_positions, v_pos);
            v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
          end loop;
          v_seed_positions := v_next_positions;
        end loop;

        for v_slot in 1..v_matches_in_round loop
          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (
            v_slot,
            case
              when v_seed_positions[(v_slot - 1) * 2 + 1] <= v_n then (
                select op.participant_id
                from tmp_ordered_participants op
                where op.seed = v_seed_positions[(v_slot - 1) * 2 + 1]
              )
              else null
            end,
            case
              when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then (
                select op.participant_id
                from tmp_ordered_participants op
                where op.seed = v_seed_positions[(v_slot - 1) * 2 + 2]
              )
              else null
            end
          )
          on conflict (bracket_slot) do update
            set home_participant_id = excluded.home_participant_id,
                away_participant_id = excluded.away_participant_id;
        end loop;
      else
        v_slot := 1;
        while exists (select 1 from tmp_unpaired_pool) and v_slot <= v_matches_in_round loop
          select seed, participant_id, group_id
          into v_anchor_seed, v_anchor_participant, v_anchor_group
          from tmp_unpaired_pool
          order by seed asc
          limit 1;

          delete from tmp_unpaired_pool where seed = v_anchor_seed;

          if exists (select 1 from tmp_unpaired_pool) then
            v_slot_branch := case when v_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end;

            select cand.participant_id
            into v_opponent_participant
            from tmp_unpaired_pool cand
            left join lateral (
              select count(*)::int as branch_group_count
              from tmp_r1_pairs p
              join tmp_group_ranked grh
                on grh.participant_id = p.home_participant_id
              where (case when p.bracket_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end) = v_slot_branch
                and grh.group_id = cand.group_id
            ) h on true
            left join lateral (
              select count(*)::int as branch_group_count
              from tmp_r1_pairs p
              join tmp_group_ranked gra
                on gra.participant_id = p.away_participant_id
              where (case when p.bracket_slot <= greatest(v_matches_in_round / 2, 1) then 1 else 2 end) = v_slot_branch
                and gra.group_id = cand.group_id
            ) a on true
            order by
              case when cand.group_id = v_anchor_group then 1 else 0 end asc,
              (coalesce(h.branch_group_count, 0) + coalesce(a.branch_group_count, 0)) asc,
              cand.seed desc,
              cand.participant_id asc
            limit 1;

            delete from tmp_unpaired_pool where participant_id = v_opponent_participant;
          else
            v_opponent_participant := null;
          end if;

          insert into tmp_r1_pairs(bracket_slot, home_participant_id, away_participant_id)
          values (v_slot, v_anchor_participant, v_opponent_participant);

          v_slot := v_slot + 1;
        end loop;
      end if;
    end if;

    for v_slot in 1..v_matches_in_round loop
      select p.home_participant_id, p.away_participant_id
      into v_home, v_away
      from tmp_r1_pairs p
      where p.bracket_slot = v_slot;

      if not found then
        v_home := null;
        v_away := null;
      end if;

      update public.matches
      set home_participant_id = v_home,
          away_participant_id = v_away
      where tournament_id = p_tournament_id
        and stage='PLAYOFF' and bracket_type='WINNERS'
        and round=1 and bracket_slot=v_slot;

      select id into v_mid
      from public.matches
      where tournament_id = p_tournament_id
        and stage='PLAYOFF' and bracket_type='WINNERS'
        and round=1 and bracket_slot=v_slot;

      perform public.sync_match_identities_from_participants(v_mid);
      perform public.balance_match_home_away(v_mid);
    end loop;
  else
    v_seed_positions := array[1, 2];
    while array_length(v_seed_positions, 1) < v_s loop
      v_next_positions := '{}'::int[];
      foreach v_pos in array v_seed_positions loop
        v_next_positions := array_append(v_next_positions, v_pos);
        v_next_positions := array_append(v_next_positions, array_length(v_seed_positions, 1) * 2 + 1 - v_pos);
      end loop;
      v_seed_positions := v_next_positions;
    end loop;

    for v_slot in 1..v_matches_in_round loop
      v_home := case
        when v_seed_positions[(v_slot - 1) * 2 + 1] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 1]]
        else null
      end;
      v_away := case
        when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 2]]
        else null
      end;

      update public.matches
      set home_participant_id = v_home,
          away_participant_id = v_away
      where tournament_id = p_tournament_id
        and stage='PLAYOFF' and bracket_type='WINNERS'
        and round=1 and bracket_slot=v_slot;

      select id into v_mid
      from public.matches
      where tournament_id = p_tournament_id
        and stage='PLAYOFF' and bracket_type='WINNERS'
        and round=1 and bracket_slot=v_slot;

      perform public.sync_match_identities_from_participants(v_mid);
      perform public.balance_match_home_away(v_mid);
    end loop;
  end if;

  if v_is_full_with_losers and v_n between 9 and 16 then
    -- The lateral join emits one row per occupied side. Count those references
    -- directly; summing match occupancy here counts full matches twice.
    select
      count(x.pid),
      count(distinct x.pid)
    into v_assigned_refs, v_distinct_assigned
    from public.matches m
    left join lateral (
      select m.home_participant_id as pid
      where m.home_participant_id is not null
      union all
      select m.away_participant_id as pid
      where m.away_participant_id is not null
    ) x on true
    where m.tournament_id = p_tournament_id
      and m.stage = 'PLAYOFF'
      and m.bracket_type = 'WINNERS'
      and m.round = 1
      and m.bracket_slot between 1 and v_matches_in_round;

    if v_assigned_refs <> v_n then
      raise exception
        'Round-1 winners assignment mismatch for tournament %: assigned_refs=% expected=% distinct_assigned=%',
        p_tournament_id, v_assigned_refs, v_n, v_distinct_assigned
        using errcode = 'P0001';
    end if;

    if v_seeded is null or coalesce(array_length(v_seeded, 1), 0) <> v_n then
      raise exception
        'Round-1 winners assignment mismatch for tournament %: seeded_count=% expected=%',
        p_tournament_id, coalesce(array_length(v_seeded, 1), 0), v_n
        using errcode = 'P0001';
    end if;

    foreach v_seed in array v_seeded loop
      select coalesce(count(*), 0)
      into v_seed_occurrences
      from public.matches m
      where m.tournament_id = p_tournament_id
        and m.stage = 'PLAYOFF'
        and m.bracket_type = 'WINNERS'
        and m.round = 1
        and m.bracket_slot between 1 and v_matches_in_round
        and (m.home_participant_id = v_seed or m.away_participant_id = v_seed);

      if v_seed_occurrences <> 1 then
        raise exception
          'Round-1 winners assignment mismatch for tournament %: participant % occurs % times (expected 1)',
          p_tournament_id, v_seed, v_seed_occurrences
          using errcode = 'P0001';
      end if;
    end loop;

    v_expected_null_null_slots := 0;
    for v_slot in 1..v_matches_in_round loop
      v_expected_home := case
        when v_seed_positions[(v_slot - 1) * 2 + 1] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 1]]
        else null
      end;
      v_expected_away := case
        when v_seed_positions[(v_slot - 1) * 2 + 2] <= v_n then v_seeded[v_seed_positions[(v_slot - 1) * 2 + 2]]
        else null
      end;

      if v_expected_home is null and v_expected_away is null then
        v_expected_null_null_slots := v_expected_null_null_slots + 1;
      end if;

      if exists (
        select 1
        from public.matches m
        where m.tournament_id = p_tournament_id
          and m.stage = 'PLAYOFF'
          and m.bracket_type = 'WINNERS'
          and m.round = 1
          and m.bracket_slot = v_slot
          and (
            ((m.home_participant_id is null) <> (v_expected_home is null))
            or ((m.away_participant_id is null) <> (v_expected_away is null))
          )
      ) then
        raise exception
          'Round-1 winners null-slot mismatch for tournament % at slot % (expected home_null=% away_null=%)',
          p_tournament_id, v_slot, (v_expected_home is null), (v_expected_away is null)
          using errcode = 'P0001';
      end if;
    end loop;

    select count(*)
    into v_actual_null_null_slots
    from public.matches m
    where m.tournament_id = p_tournament_id
      and m.stage = 'PLAYOFF'
      and m.bracket_type = 'WINNERS'
      and m.round = 1
      and m.bracket_slot between 1 and v_matches_in_round
      and m.home_participant_id is null
      and m.away_participant_id is null;

    if v_actual_null_null_slots <> v_expected_null_null_slots then
      raise exception
        'Round-1 winners null-slot mismatch for tournament %: actual_null_null_slots=% expected_null_null_slots=%',
        p_tournament_id, v_actual_null_null_slots, v_expected_null_null_slots
        using errcode = 'P0001';
    end if;
  end if;

  update public.matches
  set home_participant_id = null,
      away_participant_id = null,
      home_user_id = null,
      away_user_id = null,
      home_guest_id = null,
      away_guest_id = null
  where tournament_id = p_tournament_id
    and stage='PLAYOFF'
    and (
      (bracket_type='WINNERS' and round > 1)
      or bracket_type='LOSERS'
    );

  -- A placement match that is played has two sources. Alternate loser intake and
  -- consolidation. Preserve one-source BYE nodes in their original round;
  -- only wholly empty nodes are omitted. Each token has exactly one path.
  if v_is_full_with_losers and v_n between 3 and 16 then
    delete from public.playoff_placement_entrants where tournament_id = p_tournament_id;
    delete from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS';

    -- Use the actual seeded layout, including group-specific pairings.
    v_leaf_alive := '{}'::int[];
    for v_slot in 1..(v_s / 2) loop
      select home_participant_id, away_participant_id into v_home, v_away
      from public.matches where tournament_id = p_tournament_id and stage = 'PLAYOFF'
        and bracket_type = 'WINNERS' and round = 1 and bracket_slot = v_slot;
      v_leaf_alive := array_append(v_leaf_alive, case when v_home is null then 0 else 1 end);
      v_leaf_alive := array_append(v_leaf_alive, case when v_away is null then 0 else 1 end);
    end loop;

    v_tokens := '{}'::jsonb[];
    v_display_round := 0;
    for v_phase in 1..(2 * v_rounds - 3) loop
      v_next_tokens := '{}'::jsonb[];
      v_round_label := case
        when v_phase = 2 * v_rounds - 3 then 'Final placement'
        when v_phase > 1 and mod(v_phase, 2) = 1 then 'Placement qualifier'
        when v_phase = 1 then case v_rounds when 4 then 'Round of 16' when 3 then 'Quarter-finals' else 'Final placement' end
        when v_phase = 2 and v_rounds = 4 then 'Quarter-finals'
        else 'Semi-finals'
      end;
      if v_phase = 1 or mod(v_phase, 2) = 0 then
        v_round := case when v_phase = 1 then 1 else v_phase / 2 + 1 end;
        v_drops := '{}'::jsonb[];
        v_next_alive := '{}'::int[];
        for v_slot in 1..(array_length(v_leaf_alive, 1) / 2) loop
          v_token := null;
          if v_leaf_alive[v_slot * 2 - 1] = 1 and v_leaf_alive[v_slot * 2] = 1 then
            v_token := jsonb_build_object('kind', 'drop', 'round', v_round, 'slot', v_slot);
          end if;
          v_drops := array_append(v_drops, v_token);
          v_next_alive := array_append(v_next_alive, greatest(v_leaf_alive[v_slot * 2 - 1], v_leaf_alive[v_slot * 2]));
        end loop;
        v_leaf_alive := v_next_alive;
        v_pair_count := case when v_phase = 1 then array_length(v_drops, 1) / 2 else array_length(v_drops, 1) end;
      else
        v_pair_count := array_length(v_tokens, 1) / 2;
      end if;

      for v_slot in 1..v_pair_count loop
        if v_phase = 1 then
          v_sources := array[v_drops[v_slot * 2 - 1], v_drops[v_slot * 2]];
        elsif mod(v_phase, 2) = 0 then
          -- Cross WB drops to the opposite branch to delay rematches.
          v_sources := array[v_tokens[v_slot], v_drops[array_length(v_drops, 1) - v_slot + 1]];
        else
          v_sources := array[v_tokens[v_slot * 2 - 1], v_tokens[v_slot * 2]];
        end if;
        if v_sources[1] is null and v_sources[2] is null then
          v_next_tokens := array_append(v_next_tokens, null::jsonb);
          continue;
        end if;

        insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot, metadata)
        values (p_tournament_id, 'PLAYOFF', 'LOSERS', v_phase, v_slot,
                jsonb_build_object('placement_graph_version', 2, 'round_label', v_round_label,
                  'placement_bye', v_sources[1] is null or v_sources[2] is null))
        returning id into v_mid;
        for v_side_index in 1..2 loop
          v_token := v_sources[v_side_index];
          if v_token is null then
            continue;
          end if;
          v_drop_side := case when v_side_index = 1 then 'HOME' else 'AWAY' end;
          if v_token->>'kind' = 'drop' then
            update public.matches
            set metadata = metadata || jsonb_build_object(
              'wb_drop_' || lower(v_drop_side) || '_round', (v_token->>'round')::int,
              'wb_drop_' || lower(v_drop_side) || '_slot', (v_token->>'slot')::int)
            where id = v_mid;
          else
            update public.matches
            set next_match_id = v_mid, next_match_side = v_drop_side
            where id = (v_token->>'id')::uuid;
          end if;
        end loop;
        v_next_tokens := array_append(v_next_tokens, jsonb_build_object('kind', 'winner', 'id', v_mid));
      end loop;
      v_display_round := v_phase;
      v_tokens := v_next_tokens;
    end loop;

    -- Preserve explicit 5/6 and 7/8 classification games for eight entrants.
    if v_n = 8 then
      for v_slot in 2..3 loop
        insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot, metadata)
        values (p_tournament_id, 'PLAYOFF', 'LOSERS', v_display_round, v_slot,
          jsonb_build_object('placement_graph_version', 2,
            'classification', case when v_slot = 2 then 'extra_7th_place_game' else 'fifth_sixth_place_game' end,
            'is_additional_placement', v_slot = 2,
            'lb_loss_home_round', case when v_slot = 2 then 1 else 2 end,
            'lb_loss_home_slot', 1,
            'lb_loss_away_round', case when v_slot = 2 then 1 else 2 end,
            'lb_loss_away_slot', 2));
      end loop;
    end if;
  else
    perform public.ensure_losers_bracket(p_tournament_id);
  end if;

  if v_is_full_with_losers and v_n >= 3 and v_n <= 16 then
    perform public.advance_playoff_byes(p_tournament_id);
  else
    v_round := 1;
    for v_slot in 1..(v_s / 2) loop
      select id, home_participant_id, away_participant_id, next_match_id, next_match_side
      into r
      from public.matches
      where tournament_id = p_tournament_id
        and stage='PLAYOFF' and bracket_type='WINNERS'
        and round=v_round and bracket_slot=v_slot;

      if r.next_match_id is not null then
        if r.home_participant_id is not null and r.away_participant_id is null then
          if r.next_match_side = 'HOME' then
            update public.matches set home_participant_id = r.home_participant_id where id = r.next_match_id and home_participant_id is null;
          else
            update public.matches set away_participant_id = r.home_participant_id where id = r.next_match_id and away_participant_id is null;
          end if;
        elsif r.away_participant_id is not null and r.home_participant_id is null then
          if r.next_match_side = 'HOME' then
            update public.matches set home_participant_id = r.away_participant_id where id = r.next_match_id and home_participant_id is null;
          else
            update public.matches set away_participant_id = r.away_participant_id where id = r.next_match_id and away_participant_id is null;
          end if;
        end if;
      end if;
    end loop;
  end if;

  for r in
    select id from public.matches
    where tournament_id = p_tournament_id and stage='PLAYOFF'
  loop
    perform public.sync_match_identities_from_participants(r.id);
  end loop;
end;
$function$;

create or replace function public.advance_playoff_byes(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed boolean := true;
  r record;
  v_advancer uuid;
  v_source_locked boolean;
  v_missing_source_has_entrant boolean;
  v_versioned_placement boolean;
begin
  select exists (select 1 from public.matches where tournament_id = p_tournament_id
    and stage = 'PLAYOFF' and metadata->>'placement_graph_version' = '2') into v_versioned_placement;
  while v_changed loop
    v_changed := false;

    for r in
      select id, bracket_type, round, metadata, home_participant_id, away_participant_id, next_match_id, next_match_side
      from public.matches
      where tournament_id = p_tournament_id
        and stage = 'PLAYOFF'
      order by case bracket_type when 'WINNERS' then 1 else 2 end, round asc, bracket_slot asc
    loop
      if r.next_match_id is null or r.next_match_side is null then
        continue;
      end if;

      v_advancer := null;
      if r.home_participant_id is not null and r.away_participant_id is null then
        v_advancer := r.home_participant_id;
      elsif r.away_participant_id is not null and r.home_participant_id is null then
        v_advancer := r.away_participant_id;
      end if;

      if v_advancer is null then
        continue;
      end if;

      -- A missing side is a BYE only when its complete feeder subtree is empty.
      -- A not-yet-played feeder with real entrants must block advancement.
      if r.bracket_type = 'WINNERS' and coalesce(r.round, 0) > 1 then
        if v_versioned_placement then
          with recursive missing_sources as (
            select mx.id, mx.home_participant_id, mx.away_participant_id
            from public.matches mx
            where mx.tournament_id = p_tournament_id and mx.stage = 'PLAYOFF' and mx.bracket_type = 'WINNERS'
              and mx.next_match_id = r.id
              and mx.next_match_side = case when r.home_participant_id is null then 'HOME' else 'AWAY' end
            union all
            select mx.id, mx.home_participant_id, mx.away_participant_id
            from public.matches mx join missing_sources parent on mx.next_match_id = parent.id
            where mx.tournament_id = p_tournament_id and mx.stage = 'PLAYOFF' and mx.bracket_type = 'WINNERS'
          )
          select exists (select 1 from missing_sources
            where home_participant_id is not null or away_participant_id is not null)
          into v_missing_source_has_entrant;
          if v_missing_source_has_entrant then
            continue;
          end if;
        else
          select exists (select 1 from public.match_results wr where wr.match_id = r.id and wr.locked = true)
          into v_source_locked;
          if not coalesce(v_source_locked, false) then
            continue;
          end if;
        end if;
      end if;

      -- In full_with_losers mode, losers-bracket slots can be intentionally
      -- reserved for future winners-bracket drops. Do not auto-advance from
      -- those matches until the corresponding winners match is locked and the
      -- drop side is actually known.
      if r.bracket_type = 'LOSERS' then
        if r.metadata->>'placement_graph_version' = '2'
           and not coalesce((r.metadata->>'placement_bye')::boolean, false) then
          continue; -- Two-source nodes must wait for their second source.
        end if;

        if r.home_participant_id is null
          and (r.metadata ? 'wb_drop_home_round')
          and (r.metadata ? 'wb_drop_home_slot') then
          select exists (
            select 1
            from public.matches wm
            join public.match_results wr on wr.match_id = wm.id
            where wm.tournament_id = p_tournament_id
              and wm.stage = 'PLAYOFF'
              and wm.bracket_type = 'WINNERS'
              and wm.round = (r.metadata->>'wb_drop_home_round')::int
              and wm.bracket_slot = (r.metadata->>'wb_drop_home_slot')::int
              and wr.locked = true
          ) into v_source_locked;

          if not coalesce(v_source_locked, false) then
            continue;
          end if;
        end if;

        if r.away_participant_id is null
          and (r.metadata ? 'wb_drop_away_round')
          and (r.metadata ? 'wb_drop_away_slot') then
          select exists (
            select 1
            from public.matches wm
            join public.match_results wr on wr.match_id = wm.id
            where wm.tournament_id = p_tournament_id
              and wm.stage = 'PLAYOFF'
              and wm.bracket_type = 'WINNERS'
              and wm.round = (r.metadata->>'wb_drop_away_round')::int
              and wm.bracket_slot = (r.metadata->>'wb_drop_away_slot')::int
              and wr.locked = true
          ) into v_source_locked;

          if not coalesce(v_source_locked, false) then
            continue;
          end if;
        end if;
      end if;

      if r.next_match_side = 'HOME' then
        update public.matches
        set home_participant_id = coalesce(home_participant_id, v_advancer)
        where id = r.next_match_id
          and home_participant_id is null
          and away_participant_id is distinct from v_advancer;
      else
        update public.matches
        set away_participant_id = coalesce(away_participant_id, v_advancer)
        where id = r.next_match_id
          and away_participant_id is null
          and home_participant_id is distinct from v_advancer;
      end if;

      if found then
        perform public.sync_match_identities_from_participants(r.next_match_id);
        perform public.balance_match_home_away(r.next_match_id);
        v_changed := true;
      end if;
    end loop;
  end loop;
end;
$$;

create or replace function public.trg_place_losers_into_losers_bracket()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  m record;
  v_classification record;
  loser uuid;
  winner uuid;
  target uuid;
  v_preset text;
  v_max_round int;
  v_target_side text;
  v_gf2_id uuid;
  v_wb_drop_slot int;
  v_is_full_with_losers boolean := false;
  v_parent_round int;
  v_parent_slot int;
  v_parent_id uuid;
  v_round_slot_pos int;
  v_round_slot_total int;
  v_drop_preferred_side text;
  v_team_based boolean := false;
  v_participant_count int := 0;
  v_lb_round1_slot1_loser uuid;
  v_lb_round1_slot2_loser uuid;
  v_lb_extra_match_id uuid;
  v_lb_final_round int;
  v_lb_extra_locked boolean := false;
begin
  if new.locked is distinct from true then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if m.stage <> 'PLAYOFF' then
    return new;
  end if;

  select
    preset_id,
    public.preset_is_full_with_losers(preset_id),
    public.preset_is_team_based(preset_id)
  into v_preset, v_is_full_with_losers, v_team_based
  from public.tournaments
  where id = m.tournament_id;

  if m.bracket_type = 'LOSERS' then
    if not v_is_full_with_losers then
      return new;
    end if;

    if new.home_score > new.away_score then
      winner := m.home_participant_id;
      loser := m.away_participant_id;
    elsif new.away_score > new.home_score then
      winner := m.away_participant_id;
      loser := m.home_participant_id;
    else
      return new;
    end if;

    if winner is null then
      return new;
    end if;

    if m.metadata->>'placement_graph_version' = '2' then
      -- Classification losers have their own explicit edges; never guess a free side.
      for v_classification in
        select id, metadata from public.matches
        where tournament_id = m.tournament_id and stage = 'PLAYOFF' and bracket_type = 'LOSERS'
          and ((metadata->>'lb_loss_home_round')::int = m.round and (metadata->>'lb_loss_home_slot')::int = m.bracket_slot
            or (metadata->>'lb_loss_away_round')::int = m.round and (metadata->>'lb_loss_away_slot')::int = m.bracket_slot)
      loop
        if (v_classification.metadata->>'lb_loss_home_round')::int = m.round
           and (v_classification.metadata->>'lb_loss_home_slot')::int = m.bracket_slot then
          update public.matches set home_participant_id = coalesce(home_participant_id, loser)
          where id = v_classification.id and away_participant_id is distinct from loser;
        else
          update public.matches set away_participant_id = coalesce(away_participant_id, loser)
          where id = v_classification.id and home_participant_id is distinct from loser;
        end if;
        perform public.sync_match_identities_from_participants(v_classification.id);
        perform public.balance_match_home_away(v_classification.id);
      end loop;
      -- A just-advanced winner may feed a structural BYE in a later round.
      perform public.advance_playoff_byes(m.tournament_id);
      return new;
    end if;

    if v_is_full_with_losers and m.round = 1 then
      if v_team_based then
        select count(*)
        into v_participant_count
        from (
          select distinct tp.team_id
          from public.tournament_participants tp
          where tp.tournament_id = m.tournament_id
            and tp.team_id is not null
        ) teams;
      else
        select count(*)
        into v_participant_count
        from public.tournament_participants tp
        where tp.tournament_id = m.tournament_id;
      end if;

      -- 8-participant special case:
      -- after both initial placement eliminations are known, create one extra
      -- consolation game so the two earliest-eliminated teams get a fair game count.
      if v_participant_count = 8 then
        with round1_losers as (
          select
            mx.bracket_slot,
            case
              when mr.home_score > mr.away_score then mx.away_participant_id
              when mr.away_score > mr.home_score then mx.home_participant_id
              else null
            end as loser_participant_id
          from public.matches mx
          join public.match_results mr
            on mr.match_id = mx.id
          where mx.tournament_id = m.tournament_id
            and mx.stage = 'PLAYOFF'
            and mx.bracket_type = 'LOSERS'
            and mx.round = 1
            and mx.bracket_slot in (1, 2)
            and mr.locked = true
            and mr.home_score <> mr.away_score
        )
        select
          (array_agg(loser_participant_id) filter (where bracket_slot = 1))[1],
          (array_agg(loser_participant_id) filter (where bracket_slot = 2))[1]
        into v_lb_round1_slot1_loser, v_lb_round1_slot2_loser
        from round1_losers;

        select coalesce(max(mx.round), 1)
        into v_lb_final_round
        from public.matches mx
        where mx.tournament_id = m.tournament_id
          and mx.stage = 'PLAYOFF'
          and mx.bracket_type = 'LOSERS'
          and coalesce((mx.metadata->>'is_gf1')::boolean, false) = false
          and coalesce((mx.metadata->>'is_gf2')::boolean, false) = false
          and coalesce((mx.metadata->>'is_additional_placement')::boolean, false) = false;

        if v_lb_round1_slot1_loser is not null
           and v_lb_round1_slot2_loser is not null
           and v_lb_round1_slot1_loser is distinct from v_lb_round1_slot2_loser then
          select
            mx.id,
            coalesce(mr.locked, false)
          into v_lb_extra_match_id, v_lb_extra_locked
          from public.matches mx
          left join public.match_results mr
            on mr.match_id = mx.id
          where mx.tournament_id = m.tournament_id
            and mx.stage = 'PLAYOFF'
            and mx.bracket_type = 'LOSERS'
            and coalesce((mx.metadata->>'is_additional_placement')::boolean, false) = true
            and coalesce((mx.metadata->>'classification') = 'extra_7th_place_game', false)
          order by mx.round desc, mx.bracket_slot asc
          limit 1;

          if v_lb_extra_match_id is null then
            insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot, metadata)
            values (
              m.tournament_id,
              'PLAYOFF',
              'LOSERS',
              v_lb_final_round,
              2,
              jsonb_build_object(
                'classification', 'extra_7th_place_game',
                'is_additional_placement', true,
                'round_label', '7th/8th game',
                'lb_loss_home_round', 1,
                'lb_loss_home_slot', 1,
                'lb_loss_away_round', 1,
                'lb_loss_away_slot', 2
              )
            )
            returning id into v_lb_extra_match_id;
          end if;

          if v_lb_extra_match_id is not null and not v_lb_extra_locked then
            update public.matches
            set home_participant_id = v_lb_round1_slot1_loser,
                away_participant_id = v_lb_round1_slot2_loser,
                round = v_lb_final_round,
                bracket_slot = 2,
                next_match_id = null,
                next_match_side = null,
                metadata = coalesce(metadata, '{}'::jsonb)
                  || jsonb_build_object(
                    'classification', 'extra_7th_place_game',
                    'is_additional_placement', true,
                    'round_label', '7th/8th game',
                    'lb_loss_home_round', 1,
                    'lb_loss_home_slot', 1,
                    'lb_loss_away_round', 1,
                    'lb_loss_away_slot', 2
                  )
            where id = v_lb_extra_match_id;

            perform public.sync_match_identities_from_participants(v_lb_extra_match_id);
            perform public.balance_match_home_away(v_lb_extra_match_id);
          end if;
        end if;
      end if;
    end if;

    if coalesce((m.metadata->>'is_gf1')::boolean, false) then
      if winner = m.away_participant_id and loser is not null then
        select id into v_gf2_id
        from public.matches
        where tournament_id = m.tournament_id
          and stage = 'PLAYOFF'
          and bracket_type = 'LOSERS'
          and round = m.round + 1
          and bracket_slot = 1
          and coalesce((metadata->>'is_gf2')::boolean, false) = true;

        if v_gf2_id is null then
          insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot, metadata)
          values (m.tournament_id, 'PLAYOFF', 'LOSERS', m.round + 1, 1, jsonb_build_object('is_gf2', true))
          returning id into v_gf2_id;
        end if;

        if v_gf2_id is null then
          select id into v_gf2_id
          from public.matches
          where tournament_id = m.tournament_id
            and stage = 'PLAYOFF'
            and bracket_type = 'LOSERS'
            and round = m.round + 1
            and bracket_slot = 1
          limit 1;
        end if;

        if v_gf2_id is not null then
          update public.matches
          set home_participant_id = m.home_participant_id,
              away_participant_id = m.away_participant_id
          where id = v_gf2_id;

          perform public.sync_match_identities_from_participants(v_gf2_id);
          perform public.balance_match_home_away(v_gf2_id);
        end if;
      end if;
    end if;

    perform public.advance_playoff_byes(m.tournament_id);
    return new;
  end if;

  if m.bracket_type <> 'WINNERS' then
    return new;
  end if;

  if m.home_participant_id is null or m.away_participant_id is null then
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

  if v_is_full_with_losers and v_max_round >= 2 then
    -- Winners losers are routed via precomputed metadata mapping authored by
    -- ensure_playoff_bracket. This keeps bracket progression deterministic for
    -- all sizes 3..16 and prevents BYE-only winners nodes from emitting losers.
    select id,
           case
             when (metadata->>'wb_drop_home_round')::int = m.round
              and (metadata->>'wb_drop_home_slot')::int = m.bracket_slot then 'HOME'
             when (metadata->>'wb_drop_away_round')::int = m.round
              and (metadata->>'wb_drop_away_slot')::int = m.bracket_slot then 'AWAY'
             else null
           end as mapped_side
    into target, v_drop_preferred_side
    from public.matches
    where tournament_id = m.tournament_id
      and stage = 'PLAYOFF'
      and bracket_type = 'LOSERS'
      and (
        (
          metadata ? 'wb_drop_home_round'
          and metadata ? 'wb_drop_home_slot'
          and (metadata->>'wb_drop_home_round')::int = m.round
          and (metadata->>'wb_drop_home_slot')::int = m.bracket_slot
        )
        or
        (
          metadata ? 'wb_drop_away_round'
          and metadata ? 'wb_drop_away_slot'
          and (metadata->>'wb_drop_away_round')::int = m.round
          and (metadata->>'wb_drop_away_slot')::int = m.bracket_slot
        )
      )
    limit 1;

    if target is null then
      perform public.advance_playoff_byes(m.tournament_id);
      return new;
    end if;

    v_target_side := case
      when target is null then null
      when v_drop_preferred_side = 'HOME'
        and exists (select 1 from public.matches tm where tm.id = target and tm.home_participant_id is null)
      then 'HOME'
      when v_drop_preferred_side = 'AWAY'
        and exists (select 1 from public.matches tm where tm.id = target and tm.away_participant_id is null)
      then 'AWAY'
      when exists (select 1 from public.matches tm where tm.id = target and tm.home_participant_id is null)
      then 'HOME'
      when exists (select 1 from public.matches tm where tm.id = target and tm.away_participant_id is null)
      then 'AWAY'
      else v_drop_preferred_side
    end;

    if target is not null and v_target_side is not null then
      if v_target_side = 'HOME' then
        update public.matches
        set home_participant_id = coalesce(home_participant_id, loser)
        where id = target
          and away_participant_id is distinct from loser;
      else
        update public.matches
        set away_participant_id = coalesce(away_participant_id, loser)
        where id = target
          and home_participant_id is distinct from loser;
      end if;

      perform public.sync_match_identities_from_participants(target);
      perform public.balance_match_home_away(target);
    end if;

    perform public.advance_playoff_byes(m.tournament_id);
    return new;
  end if;

  if public.preset_is_playoff_only(v_preset)
     or not public.preset_is_full_with_losers(v_preset) then
    perform public.ensure_losers_bracket(m.tournament_id);

    if m.round = greatest(v_max_round - 1, 1) then
      select id into target
      from public.matches
      where tournament_id = m.tournament_id
        and stage = 'PLAYOFF'
        and bracket_type = 'LOSERS'
        and round = 1
        and bracket_slot = 1;

      if target is not null then
        update public.matches
        set home_participant_id = coalesce(home_participant_id, loser),
            away_participant_id = case
              when coalesce(home_participant_id, loser) is not null
               and away_participant_id is null
               and coalesce(home_participant_id, loser) is distinct from loser
              then loser
              else away_participant_id
            end
        where id = target;

        perform public.sync_match_identities_from_participants(target);
        perform public.balance_match_home_away(target);
      end if;
    end if;
  end if;

  return new;
end;
$function$;
