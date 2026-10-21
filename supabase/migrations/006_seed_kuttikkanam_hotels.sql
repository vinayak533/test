-- ============================================================================
-- 006_seed_kuttikkanam_hotels.sql — two more hotels, ten rooms each.
--
--   royal_kuttikkanam   Royal Hotel   Rooms 1–6 Normal ₹3,000 · 7–10 Luxury ₹5,500
--   taj_kuttikkanam     Taj Hotel     Rooms 1–5 Normal ₹4,000 · 6–10 Luxury ₹7,500
--   Capacity            3 guests per room
--   Policy              check-in from 14:00, check-out by 12:00
--
-- Nothing else changes: every table, function and constraint from 001–005 is
-- already keyed by hotel_id. A room belongs to exactly one hotel, and the
-- double-booking constraint is per room, so a booking at one hotel can never
-- touch another hotel's availability.
--
-- Same rules as 002: safe to re-run, keyed on (hotel id) and (hotel id, room
-- number); rates, types, capacity and the active flag are written only when a
-- room is first created, so an edit made in the admin dashboard survives.
-- Contact details are left empty for the admin to fill in — no phone number
-- or address beyond the town is invented here.
-- ============================================================================

insert into public.hotels (id, name, aliases, description, address,
                           timezone, currency, check_in_time, check_out_time, hold_minutes, max_stay_nights)
values
  ('royal_kuttikkanam', 'Royal Hotel',
   array['royal hotel', 'hotel royal', 'royal hotel kuttikkanam', 'the royal', 'royal'],
   'A hotel in Kuttikkanam with Normal and Luxury rooms.',
   'Kuttikkanam, Peermade, Idukki, Kerala',
   'Asia/Kolkata', 'INR', '14:00', '12:00', 15, 30),
  ('taj_kuttikkanam', 'Taj Hotel',
   array['taj hotel', 'hotel taj', 'taj hotel kuttikkanam', 'the taj', 'taj'],
   'A hotel in Kuttikkanam with Normal and Luxury rooms.',
   'Kuttikkanam, Peermade, Idukki, Kerala',
   'Asia/Kolkata', 'INR', '14:00', '12:00', 15, 30)
on conflict (id) do update
  set name = excluded.name,
      aliases = excluded.aliases,
      timezone = excluded.timezone,
      currency = excluded.currency,
      description = coalesce(public.hotels.description, excluded.description),
      address     = coalesce(public.hotels.address, excluded.address);

insert into public.rooms (hotel_id, room_number, room_type, name, price_per_night, max_guests, is_active)
select 'royal_kuttikkanam', n,
       case when n <= 6 then 'Normal' else 'Luxury' end,
       case when n <= 6 then 'Normal Room ' else 'Luxury Room ' end || n,
       case when n <= 6 then 3000.00 else 5500.00 end,
       3,
       true
from generate_series(1, 10) as n
on conflict (hotel_id, room_number) do nothing;

insert into public.rooms (hotel_id, room_number, room_type, name, price_per_night, max_guests, is_active)
select 'taj_kuttikkanam', n,
       case when n <= 5 then 'Normal' else 'Luxury' end,
       case when n <= 5 then 'Normal Room ' else 'Luxury Room ' end || n,
       case when n <= 5 then 4000.00 else 7500.00 end,
       3,
       true
from generate_series(1, 10) as n
on conflict (hotel_id, room_number) do nothing;

-- The guest area listens to inventory_pulse per hotel (005).
insert into public.inventory_pulse (hotel_id) select id from public.hotels on conflict do nothing;
