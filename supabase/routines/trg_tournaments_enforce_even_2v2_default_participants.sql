begin
  if new.preset_id in ('2v2_tournament', '2v2_playoffs') and mod(new.default_participants, 2) <> 0 then
    raise exception '2v2 tournaments require an even default participant count';
  end if;

  return new;
end;
