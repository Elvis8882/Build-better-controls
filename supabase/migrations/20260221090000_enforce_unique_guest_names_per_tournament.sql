create unique index if not exists tournament_guests_tournament_display_name_unique
  on public.tournament_guests (tournament_id, lower(trim(display_name)));
