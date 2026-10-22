-- ============================================================================
-- 001_schema.sql — hotels, rooms, guests, reservations.
--
-- Idempotent: safe to run any number of times, on a fresh project or on one
-- that still has the earlier prototype tables (rooms 101–204, text room
-- numbers, a `status` column on rooms, bookings MM-2026-8xx). Those prototype
-- rows were demo data copied from the old admin mock-up; they are removed by
-- their exact keys and the tables are rebuilt in the shape below. If anything
-- other than those demo rows is found in a table that needs rebuilding, the
-- migration stops instead of deleting it.
--
-- Conventions
--   * Money is numeric(10,2) / numeric(12,2), always INR.
--   * A stay is a half-open range of nights [check_in, check_out): a guest
--     leaving on the 22nd does not block a guest arriving on the 22nd. The
--     hotel's own policy (check-out by 12:00, check-in from 14:00) is what
--     makes that same-day turnover possible, and a constraint keeps it so.
-- ============================================================================

create extension if not exists btree_gist;

-- ------------------------------------------------- legacy prototype cleanup --
do $$
declare
  legacy_refs  text[] := array['MM-2026-879','MM-2026-881','MM-2026-882','MM-2026-884','MM-2026-886','MM-2026-890'];
  legacy_rooms text[] := array['101','102','103','201','202','203','204'];
  leftover int;
begin
  -- Old reservations table: had `guests` and `guest_name` but no `num_guests`.
  if to_regclass('public.reservations') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'reservations' and column_name = 'guests')
     and not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'reservations' and column_name = 'num_guests')
  then
    delete from public.reservations where booking_ref = any(legacy_refs);
    select count(*) into leftover from public.reservations;
    if leftover > 0 then
      raise exception 'reservations has % non-demo rows in the old shape; migrate them by hand before running this', leftover;
    end if;
    drop table public.reservations;
  end if;

  -- Old rooms table: text room numbers and a `status` column.
  if to_regclass('public.rooms') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'rooms' and column_name = 'status')
  then
    if to_regclass('public.reservations') is not null then
      raise exception 'rooms is in the old shape but reservations is not; refusing to guess';
    end if;
    delete from public.rooms where hotel_id = 'misty_mountain' and room_number::text = any(legacy_rooms);
    select count(*) into leftover from public.rooms;
    if leftover > 0 then
      raise exception 'rooms has % non-demo rows in the old shape; migrate them by hand before running this', leftover;
    end if;
    drop table public.rooms;
  end if;
end $$;

-- ---------------------------------------------------------------- hotels ----
create table if not exists public.hotels (
  id          text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  name        text not null,
  created_at  timestamptz not null default now()
);

alter table public.hotels add column if not exists aliases          text[]      not null default '{}';
alter table public.hotels add column if not exists description      text;
alter table public.hotels add column if not exists address          text;
alter table public.hotels add column if not exists phone            text;
alter table public.hotels add column if not exists email            text;
alter table public.hotels add column if not exists timezone         text        not null default 'Asia/Kolkata';
alter table public.hotels add column if not exists currency         text        not null default 'INR';
alter table public.hotels add column if not exists check_in_time    time        not null default '14:00';
alter table public.hotels add column if not exists check_out_time   time        not null default '12:00';
alter table public.hotels add column if not exists hold_minutes     smallint    not null default 15;
alter table public.hotels add column if not exists max_stay_nights  smallint    not null default 30;
alter table public.hotels add column if not exists is_active        boolean     not null default true;
alter table public.hotels add column if not exists updated_at       timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hotels_currency_inr') then
    alter table public.hotels add constraint hotels_currency_inr check (currency = 'INR');
  end if;
  -- Same-day turnover is only honest if the previous guest is out before
  -- the next one may check in.
  if not exists (select 1 from pg_constraint where conname = 'hotels_turnover_policy') then
    alter table public.hotels add constraint hotels_turnover_policy check (check_out_time <= check_in_time);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hotels_hold_minutes_range') then
    alter table public.hotels add constraint hotels_hold_minutes_range check (hold_minutes between 1 and 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hotels_max_stay_range') then
    alter table public.hotels add constraint hotels_max_stay_range check (max_stay_nights between 1 and 365);
  end if;
end $$;

-- -------------------------------------------------------------- agencies ----
-- The agency is the parent organisation; every hotel is one of its clients
-- (a tenant). Everything below hotels — rooms, guests, reservations — is
-- already keyed by hotel_id, so a hotel's data stays its own whichever
-- agency it belongs to.
--
-- The agency row is created here, not in a seed, because hotels.agency_id
-- points at it and existing hotels are filled in with it when the column is
-- first added. Its name is set only when it is first created, so a rename
-- survives a re-run.
create table if not exists public.agencies (
  id          text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  name        text not null check (char_length(name) between 2 and 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.agencies (id, name) values ('kuttikkanam_agency', 'Kuttikkanam Hotel Agency')
on conflict (id) do nothing;

alter table public.hotels add column if not exists agency_id text not null default 'kuttikkanam_agency'
  references public.agencies(id) on delete restrict;
create index if not exists hotels_agency_idx on public.hotels (agency_id);

-- ----------------------------------------------------------- hotel staff ----
-- Hotel-level users: a signed-in user listed here may manage that hotel and
-- no other. Agency administrators (app_metadata.hotel_role = 'admin') manage
-- every hotel and need no rows here. Written only with the service-role key
-- (scripts/create_admin.js --hotel), so nobody can add themselves; removing
-- a row takes effect on the user's next request, not at token expiry.
create table if not exists public.hotel_staff (
  user_id     uuid not null references auth.users(id) on delete cascade,
  hotel_id    text not null references public.hotels(id) on delete cascade,
  role        text not null default 'manager' check (role in ('manager')),
  created_at  timestamptz not null default now(),
  primary key (user_id, hotel_id)
);
create index if not exists hotel_staff_hotel_idx on public.hotel_staff (hotel_id);

-- ----------------------------------------------------------------- rooms ----
create table if not exists public.rooms (
  id               uuid primary key default gen_random_uuid(),
  hotel_id         text not null references public.hotels(id) on delete cascade,
  room_number      integer not null check (room_number > 0),
  room_type        text not null check (room_type in ('Normal', 'Luxury')),
  name             text,
  price_per_night  numeric(10,2) not null check (price_per_night > 0 and price_per_night <= 1000000),
  max_guests       smallint not null default 3 check (max_guests between 1 and 10),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint rooms_hotel_number_key unique (hotel_id, room_number)
);

create index if not exists rooms_hotel_idx on public.rooms (hotel_id);

-- ---------------------------------------------------------------- guests ----
create table if not exists public.guests (
  id          uuid primary key default gen_random_uuid(),
  hotel_id    text not null references public.hotels(id) on delete cascade,
  full_name   text not null check (char_length(full_name) between 2 and 120),
  email       text not null check (email = lower(email) and char_length(email) <= 254
                                   and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone       text not null check (phone ~ '^\+[0-9]{8,15}$'),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- One profile per address per hotel, so repeat stays build a history.
  constraint guests_hotel_email_key unique (hotel_id, email)
);

-- ---------------------------------------------------------- reservations ----
-- One row per room. A booking of two rooms is two rows sharing a booking_ref.
--
-- status
--   held         temporary lock while the guest completes the booking; it
--                blocks the room only until hold_expires_at
--   confirmed    booked
--   checked_in   in house
--   checked_out  stay finished; the room is free again
--   cancelled    released by the hotel
--   no_show      guest never arrived; released
--   expired      a hold that lapsed or was abandoned; released
create table if not exists public.reservations (
  id               uuid primary key default gen_random_uuid(),
  booking_ref      text not null check (booking_ref ~ '^MM-[A-Z0-9]{6}$'),
  hotel_id         text not null references public.hotels(id) on delete cascade,
  room_id          uuid not null references public.rooms(id) on delete restrict,
  guest_id         uuid references public.guests(id) on delete restrict,
  guest_name       text,
  guest_email      text,
  guest_phone      text,
  check_in         date not null,
  check_out        date not null,
  arrival_time     time,
  departure_time   time,
  num_guests       smallint not null check (num_guests between 1 and 10),
  room_type        text not null,
  price_per_night  numeric(10,2) not null check (price_per_night >= 0),
  nights           integer generated always as (check_out - check_in) stored,
  total_price      numeric(12,2) not null check (total_price >= 0),
  currency         text not null default 'INR' check (currency = 'INR'),
  status           text not null check (status in ('held', 'confirmed', 'checked_in', 'checked_out',
                                                   'cancelled', 'no_show', 'expired')),
  source           text not null default 'chatbot' check (source in ('chatbot', 'admin')),
  hold_token_hash  text check (hold_token_hash ~ '^[0-9a-f]{64}$'),
  hold_expires_at  timestamptz,
  confirmed_at     timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text check (char_length(cancel_reason) <= 300),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  stay             daterange generated always as (daterange(check_in, check_out, '[)')) stored,

  constraint reservations_dates_valid     check (check_out > check_in),
  constraint reservations_total_matches   check (total_price = price_per_night * (check_out - check_in)),
  constraint reservations_hold_complete   check (status <> 'held' or (hold_expires_at is not null and hold_token_hash is not null)),
  constraint reservations_guest_required  check (status in ('held', 'expired') or guest_id is not null),
  constraint reservations_ref_room_key    unique (booking_ref, room_id)
);

-- The guest account that made the booking (Supabase Auth). Authentication
-- stays in auth.users; a reservation only points at it. Null for bookings
-- made before guest accounts existed, and for holds not yet confirmed.
alter table public.reservations
  add column if not exists user_id uuid references auth.users(id) on delete set null;
create index if not exists reservations_user_idx on public.reservations (user_id) where user_id is not null;

-- The last line of defence against double-booking: a room can never carry
-- two live rows for the same night, whatever the application does. A held
-- row past its expiry still counts here until it is swept to 'expired',
-- which every function that writes a hold or a booking does first.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reservations_no_double_booking') then
    alter table public.reservations
      add constraint reservations_no_double_booking
      exclude using gist (room_id with =, stay with &&)
      where (status in ('held', 'confirmed', 'checked_in'));
  end if;
end $$;

create index if not exists reservations_hotel_dates_idx on public.reservations (hotel_id, check_in, check_out);
create index if not exists reservations_ref_idx         on public.reservations (booking_ref);
create index if not exists reservations_guest_idx       on public.reservations (guest_id);
create index if not exists reservations_held_idx        on public.reservations (hold_expires_at) where status = 'held';

-- ------------------------------------------------------ updated_at touch ----
create or replace function public.touch_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists agencies_touch on public.agencies;
create trigger agencies_touch before update on public.agencies
  for each row execute function public.touch_updated_at();

drop trigger if exists hotels_touch on public.hotels;
create trigger hotels_touch before update on public.hotels
  for each row execute function public.touch_updated_at();

drop trigger if exists rooms_touch on public.rooms;
create trigger rooms_touch before update on public.rooms
  for each row execute function public.touch_updated_at();

drop trigger if exists guests_touch on public.guests;
create trigger guests_touch before update on public.guests
  for each row execute function public.touch_updated_at();

drop trigger if exists reservations_touch on public.reservations;
create trigger reservations_touch before update on public.reservations
  for each row execute function public.touch_updated_at();
