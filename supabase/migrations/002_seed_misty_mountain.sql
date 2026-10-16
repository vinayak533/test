-- ============================================================================
-- 002_seed_misty_mountain.sql — the one hotel and its ten rooms.
--
--   Rooms 1–6   Normal   ₹2,500 / night
--   Rooms 7–10  Luxury   ₹4,500 / night
--   Capacity    3 guests per room (the estate's published maximum occupancy)
--   Policy      check-in from 14:00, check-out by 12:00 (published terms)
--
-- Safe to re-run: rows are keyed on (hotel id) and (hotel id, room number),
-- so nothing is ever duplicated. Prices, room types, capacity and the active
-- flag are written only when a room is first created — after that they belong
-- to the admin dashboard, and re-running the seed must not undo an edit.
-- ============================================================================

insert into public.hotels (id, name, aliases, description, address, phone, email,
                           timezone, currency, check_in_time, check_out_time, hold_minutes, max_stay_nights)
values (
  'misty_mountain',
  'Misty Mountain',
  array['misty mountain', 'misty mountain resort', 'misty mountain plantation resort',
        'misty mountain plantation', 'misty'],
  'A working tea and cardamom plantation resort in the Western Ghats.',
  'Kuttikkanam, Peermade, Idukki, Kerala',
  '+91 94478 48123',
  'reservations@mistymountainexperience.in',
  'Asia/Kolkata', 'INR', '14:00', '12:00', 15, 30
)
on conflict (id) do update
  set name = excluded.name,
      aliases = excluded.aliases,
      timezone = excluded.timezone,
      currency = excluded.currency,
      -- Descriptive fields: fill them in if empty, never overwrite an edit.
      description = coalesce(public.hotels.description, excluded.description),
      address     = coalesce(public.hotels.address, excluded.address),
      phone       = coalesce(public.hotels.phone, excluded.phone),
      email       = coalesce(public.hotels.email, excluded.email);

insert into public.rooms (hotel_id, room_number, room_type, name, price_per_night, max_guests, is_active)
select 'misty_mountain', n,
       case when n <= 6 then 'Normal' else 'Luxury' end,
       case when n <= 6 then 'Normal Room ' else 'Luxury Room ' end || n,
       case when n <= 6 then 2500.00 else 4500.00 end,
       3,
       true
from generate_series(1, 10) as n
on conflict (hotel_id, room_number) do nothing;
