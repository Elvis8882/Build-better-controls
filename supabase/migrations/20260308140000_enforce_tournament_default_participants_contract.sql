create or replace function public.trg_tournaments_enforce_even_2v2_default_participants()
returns trigger
language plpgsql
as $$
begin
  if new.preset_id in ('2v2_tournament', '2v2_playoffs') then
    if new.default_participants < 4 or new.default_participants > 16 then
      raise exception '2v2 tournaments require between 4 and 16 default participants.';
    end if;

    if mod(new.default_participants, 2) <> 0 then
      raise exception '2v2 tournaments require an even default participant count.';
    end if;
  else
    if new.default_participants < 3 then
      raise exception 'Participants must be between 3 and 16.';
    end if;
  end if;

  if new.default_participants > 16 then
    raise exception 'Participants must be between 3 and 16.';
  end if;

  return new;
end;
$$;

drop trigger if exists tournaments_enforce_even_2v2_default_participants on public.tournaments;
create trigger tournaments_enforce_even_2v2_default_participants
before insert or update on public.tournaments
for each row execute function public.trg_tournaments_enforce_even_2v2_default_participants();
