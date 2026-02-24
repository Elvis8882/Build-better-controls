create or replace function public.trg_advance_playoff_winner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  winner uuid;
  v_parent_id uuid;
  v_parent_side text;
begin
  -- only on lock
  if new.locked is distinct from true then
    return new;
  end if;

  select *
  into m
  from public.matches
  where id = new.match_id;

  if m.stage <> 'PLAYOFF' then
    return new;
  end if;

  -- determine winner (no ties expected)
  if new.home_score > new.away_score then
    winner := m.home_participant_id;
  elsif new.away_score > new.home_score then
    winner := m.away_participant_id;
  else
    --return new implies no advance on tie
    return new;
  end if;

  if m.next_match_id is null or m.next_match_side is null then
    -- Placement safety net: rebuild missing losers-bracket parent pointers
    -- so quarterfinal placement winners can continue advancing.
    if m.bracket_type = 'LOSERS' then
      insert into public.matches(tournament_id, stage, bracket_type, round, bracket_slot)
      select m.tournament_id, 'PLAYOFF', 'LOSERS', m.round + 1, ceil(greatest(coalesce(m.bracket_slot, 1), 1) / 2.0)::int
      where not exists (
        select 1
        from public.matches mx
        where mx.tournament_id = m.tournament_id
          and mx.stage = 'PLAYOFF'
          and mx.bracket_type = 'LOSERS'
          and mx.round = m.round + 1
          and mx.bracket_slot = ceil(greatest(coalesce(m.bracket_slot, 1), 1) / 2.0)::int
      );

      select id
      into v_parent_id
      from public.matches
      where tournament_id = m.tournament_id
        and stage = 'PLAYOFF'
        and bracket_type = 'LOSERS'
        and round = m.round + 1
        and bracket_slot = ceil(greatest(coalesce(m.bracket_slot, 1), 1) / 2.0)::int
      limit 1;

      v_parent_side := case when mod(greatest(coalesce(m.bracket_slot, 1), 1), 2) = 1 then 'HOME' else 'AWAY' end;

      if v_parent_id is not null then
        update public.matches
        set next_match_id = v_parent_id,
            next_match_side = v_parent_side
        where id = m.id;

        m.next_match_id := v_parent_id;
        m.next_match_side := v_parent_side;
      else
        return new;
      end if;
    else
      return new;
    end if;
  end if;

  if m.next_match_side = 'HOME' then
    update public.matches
    set home_participant_id = winner,
        away_participant_id = case
          when away_participant_id = winner then null
          else away_participant_id
        end
    where id = m.next_match_id;
  else
    update public.matches
    set away_participant_id = winner,
        home_participant_id = case
          when home_participant_id = winner then null
          else home_participant_id
        end
    where id = m.next_match_id;
  end if;

  perform public.sync_match_identities_from_participants(m.next_match_id);
  perform public.balance_match_home_away(m.next_match_id);

  return new;
end;
$$;
