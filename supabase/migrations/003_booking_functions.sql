-- ============================================================================
-- 003_booking_functions.sql — availability, holds, bookings, look-ups.
--
-- Every write to reservations made on behalf of a guest goes through one of
-- these functions, each of which runs as a single transaction:
--
--   get_availability   which active rooms are free for [check_in, check_out)
--   hold_rooms         lock specific rooms for a few minutes while the guest
--                      completes the booking (status 'held')
--   confirm_booking    turn a hold into a confirmed booking, after the guest
--                      has explicitly confirmed; re-takes a lapsed hold only
--                      if nobody else has the room
--   release_hold       give a hold back (guest started over)
--   find_booking       a booking, for a guest who knows its reference and
--                      the email or phone it was made with
--
-- They are SECURITY DEFINER and executable by service_role only (see 004):
-- the public anon key cannot call them. The Netlify function calls them with
-- the service-role key after validating the guest's input itself.
--
-- What blocks a room for a night:
--   confirmed, checked_in            always
--   held                             until hold_expires_at
--   checked_out, cancelled, no_show, expired   never
-- ============================================================================

-- --------------------------------------------------------------- helpers ----

-- MM-XXXXXX from an alphabet without 0/O/1/I/L, so a reference read out over
-- the phone cannot be misheard into someone else's.
create or replace function public.new_booking_ref()
returns text language plpgsql volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b   bytea;
  ref text;
begin
  loop
    b := uuid_send(gen_random_uuid());
    ref := 'MM-';
    for i in 0..5 loop
      ref := ref || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.reservations where booking_ref = ref);
  end loop;
  return ref;
end $$;

-- The booking as one JSON document: shared fields once, rooms as a list.
create or replace function public.booking_json(p_ref text)
returns jsonb language sql stable
set search_path = ''
as $$
  select case when count(*) = 0 then null else jsonb_build_object(
    'booking_ref',     p_ref,
    'hotel_id',        min(x.hotel_id),
    'status',          case when count(distinct x.status) = 1 then min(x.status) else 'mixed' end,
    'check_in',        min(x.check_in),
    'check_out',       max(x.check_out),
    'nights',          max(x.nights),
    'arrival_time',    to_char(min(x.arrival_time), 'HH24:MI'),
    'departure_time',  to_char(min(x.departure_time), 'HH24:MI'),
    'num_guests',      sum(x.num_guests),
    'guest_name',      min(x.guest_name),
    'guest_email',     min(x.guest_email),
    'guest_phone',     min(x.guest_phone),
    'total_price',     sum(x.total_price),
    'currency',        'INR',
    'hold_expires_at', min(x.hold_expires_at),
    'confirmed_at',    min(x.confirmed_at),
    'rooms', jsonb_agg(jsonb_build_object(
                'room_id',         r.id,
                'room_number',     r.room_number,
                'room_type',       x.room_type,
                'price_per_night', x.price_per_night,
                'num_guests',      x.num_guests,
                'total_price',     x.total_price
              ) order by r.room_number)
  ) end
  from public.reservations x
  join public.rooms r on r.id = x.room_id
  where x.booking_ref = p_ref
$$;

-- Lapsed holds → 'expired'. Called by the writers below for the rooms they
-- touch; safe to call at any time.
create or replace function public.sweep_expired_holds(p_room_ids uuid[] default null)
returns integer language plpgsql volatile security definer
set search_path = ''
as $$
declare n integer;
begin
  update public.reservations
     set status = 'expired'
   where status = 'held'
     and hold_expires_at <= now()
     and (p_room_ids is null or room_id = any(p_room_ids));
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------- availability ----
create or replace function public.get_availability(p_hotel_id text, p_check_in date, p_check_out date)
returns table (room_id uuid, room_number integer, room_type text, name text,
               price_per_night numeric, max_guests smallint, is_available boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in then
    raise exception 'invalid_dates' using errcode = '22023';
  end if;
  return query
    select r.id, r.room_number, r.room_type, r.name, r.price_per_night, r.max_guests,
           not exists (
             select 1 from public.reservations x
             where x.room_id = r.id
               and x.stay && daterange(p_check_in, p_check_out, '[)')
               and (x.status in ('confirmed', 'checked_in')
                    or (x.status = 'held' and x.hold_expires_at > now()))
           )
    from public.rooms r
    join public.hotels h on h.id = r.hotel_id and h.is_active
    where r.hotel_id = p_hotel_id and r.is_active
    order by r.room_number;
end $$;

-- ----------------------------------------------------------------- holds ----
create or replace function public.hold_rooms(
  p_hotel_id       text,
  p_room_ids       uuid[],
  p_guests         integer[],
  p_check_in       date,
  p_check_out      date,
  p_arrival_time   time,
  p_departure_time time,
  p_token_hash     text
)
returns jsonb language plpgsql volatile security definer
set search_path = ''
as $$
declare
  h          public.hotels%rowtype;
  v_today    date;
  v_n        integer := coalesce(array_length(p_room_ids, 1), 0);
  v_found    integer;
  v_bad      integer[];
  v_ref      text;
  v_expires  timestamptz;
begin
  select * into h from public.hotels where id = p_hotel_id and is_active;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_hotel');
  end if;
  v_today := (now() at time zone h.timezone)::date;

  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in then
    return jsonb_build_object('ok', false, 'reason', 'invalid_dates');
  elsif p_check_in < v_today then
    return jsonb_build_object('ok', false, 'reason', 'past_date');
  elsif p_check_out - p_check_in > h.max_stay_nights then
    return jsonb_build_object('ok', false, 'reason', 'too_long');
  elsif p_check_in > v_today + 540 then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;
  if v_n = 0 or v_n > 10 or coalesce(array_length(p_guests, 1), 0) <> v_n
     or (select count(distinct u) from unnest(p_room_ids) u) <> v_n then
    return jsonb_build_object('ok', false, 'reason', 'invalid_rooms');
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_token');
  end if;
  if p_departure_time is not null and p_departure_time > h.check_out_time then
    return jsonb_build_object('ok', false, 'reason', 'late_checkout');
  end if;

  -- Serialise every writer on these rooms. Ordered by id, so two holds over
  -- overlapping sets of rooms queue rather than deadlock.
  perform 1 from public.rooms where id = any(p_room_ids) order by id for update;

  select count(*) into v_found
    from public.rooms where id = any(p_room_ids) and hotel_id = p_hotel_id and is_active;
  if v_found <> v_n then
    return jsonb_build_object('ok', false, 'reason', 'unavailable', 'rooms', '[]'::jsonb);
  end if;

  select array_agg(r.room_number order by r.room_number) into v_bad
    from unnest(p_room_ids, p_guests) as u(rid, g)
    join public.rooms r on r.id = u.rid
   where u.g is null or u.g < 1 or u.g > r.max_guests;
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'reason', 'over_capacity', 'rooms', to_jsonb(v_bad));
  end if;

  perform public.sweep_expired_holds(p_room_ids);

  select array_agg(distinct r.room_number order by r.room_number) into v_bad
    from public.reservations x
    join public.rooms r on r.id = x.room_id
   where x.room_id = any(p_room_ids)
     and x.stay && daterange(p_check_in, p_check_out, '[)')
     and x.status in ('held', 'confirmed', 'checked_in');
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'reason', 'unavailable', 'rooms', to_jsonb(v_bad));
  end if;

  v_ref := public.new_booking_ref();
  v_expires := now() + make_interval(mins => h.hold_minutes);

  insert into public.reservations (
    booking_ref, hotel_id, room_id, check_in, check_out, arrival_time, departure_time,
    num_guests, room_type, price_per_night, total_price, status, source,
    hold_token_hash, hold_expires_at)
  select v_ref, p_hotel_id, r.id, p_check_in, p_check_out, p_arrival_time,
         coalesce(p_departure_time, h.check_out_time),
         u.g, r.room_type, r.price_per_night, r.price_per_night * (p_check_out - p_check_in),
         'held', 'chatbot', p_token_hash, v_expires
    from unnest(p_room_ids, p_guests) as u(rid, g)
    join public.rooms r on r.id = u.rid;

  return jsonb_build_object('ok', true, 'booking', public.booking_json(v_ref));
exception
  when exclusion_violation then
    return jsonb_build_object('ok', false, 'reason', 'unavailable', 'rooms', '[]'::jsonb);
end $$;

create or replace function public.release_hold(p_booking_ref text, p_token_hash text)
returns integer language plpgsql volatile security definer
set search_path = ''
as $$
declare n integer;
begin
  update public.reservations
     set status = 'expired'
   where booking_ref = p_booking_ref and hold_token_hash = p_token_hash and status = 'held';
  get diagnostics n = row_count;
  return n;
end $$;

-- -------------------------------------------------------------- bookings ----
drop function if exists public.confirm_booking(text, text, text, text, text);
drop function if exists public.confirm_booking(text, text, text, text, text, time, time);
-- p_user_id is the signed-in guest account, already verified by the server
-- from the guest's access token; the booking is linked to it.
create or replace function public.confirm_booking(
  p_booking_ref    text,
  p_token_hash     text,
  p_guest_name     text,
  p_guest_email    text,
  p_guest_phone    text,
  p_arrival_time   time default null,
  p_departure_time time default null,
  p_user_id        uuid default null
)
returns jsonb language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name   text := btrim(coalesce(p_guest_name, ''));
  v_email  text := lower(btrim(coalesce(p_guest_email, '')));
  v_phone  text := btrim(coalesce(p_guest_phone, ''));
  v_rooms  uuid[];
  v_total  integer;
  v_done   integer;
  v_live   integer;
  v_closed integer;
  v_hotel  text;
  v_guest  uuid;
  v_bad    integer[];
  v_out    time;
begin
  if char_length(v_name) not between 2 and 120
     or char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or v_phone !~ '^\+[0-9]{8,15}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_guest');
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select array_agg(room_id order by room_id) into v_rooms
    from public.reservations where booking_ref = p_booking_ref and hold_token_hash = p_token_hash;
  if v_rooms is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Same lock order as hold_rooms.
  perform 1 from public.rooms where id = any(v_rooms) order by id for update;
  perform 1 from public.reservations
    where booking_ref = p_booking_ref and hold_token_hash = p_token_hash order by id for update;

  select count(*),
         count(*) filter (where status = 'confirmed'),
         count(*) filter (where status = 'held' and hold_expires_at > now()),
         count(*) filter (where status in ('cancelled', 'no_show', 'checked_in', 'checked_out')),
         min(hotel_id)
    into v_total, v_done, v_live, v_closed, v_hotel
    from public.reservations where booking_ref = p_booking_ref and hold_token_hash = p_token_hash;

  -- A second press of "Confirm" (or a retry after a lost response) must not
  -- book twice: it gets the same booking back.
  if v_done = v_total then
    return jsonb_build_object('ok', true, 'already', true, 'booking', public.booking_json(p_booking_ref));
  end if;
  if v_closed > 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select check_out_time into v_out from public.hotels where id = v_hotel;
  if p_departure_time is not null and p_departure_time > v_out then
    return jsonb_build_object('ok', false, 'reason', 'late_checkout');
  end if;

  if v_live < v_total then
    -- The hold lapsed. The rooms can still be had if nobody else took them.
    perform public.sweep_expired_holds(v_rooms);
    select array_agg(distinct r.room_number order by r.room_number) into v_bad
      from public.reservations mine
      join public.reservations x
        on x.room_id = mine.room_id and x.id <> mine.id and x.stay && mine.stay
       and x.status in ('held', 'confirmed', 'checked_in')
      join public.rooms r on r.id = x.room_id
     where mine.booking_ref = p_booking_ref and mine.hold_token_hash = p_token_hash;
    if v_bad is null then
      select array_agg(r.room_number order by r.room_number) into v_bad
        from public.reservations mine join public.rooms r on r.id = mine.room_id
       where mine.booking_ref = p_booking_ref and mine.hold_token_hash = p_token_hash and not r.is_active;
    end if;
    if v_bad is not null then
      update public.reservations set status = 'expired'
       where booking_ref = p_booking_ref and hold_token_hash = p_token_hash and status = 'held';
      return jsonb_build_object('ok', false, 'reason', 'unavailable', 'rooms', to_jsonb(v_bad));
    end if;
  end if;

  -- One guest profile per email address. An existing profile is not
  -- overwritten from a public form; the booking keeps its own contact copy.
  insert into public.guests (hotel_id, full_name, email, phone)
  values (v_hotel, v_name, v_email, v_phone)
  on conflict (hotel_id, email) do update set updated_at = now()
  returning id into v_guest;

  update public.reservations
     set status = 'confirmed', guest_id = v_guest,
         guest_name = v_name, guest_email = v_email, guest_phone = v_phone,
         arrival_time = p_arrival_time,
         departure_time = coalesce(p_departure_time, v_out),
         confirmed_at = now(), hold_expires_at = null,
         user_id = coalesce(p_user_id, user_id)
   where booking_ref = p_booking_ref and hold_token_hash = p_token_hash
     and status in ('held', 'expired');

  return jsonb_build_object('ok', true, 'already', false, 'booking', public.booking_json(p_booking_ref));
exception
  when exclusion_violation then
    return jsonb_build_object('ok', false, 'reason', 'unavailable', 'rooms', '[]'::jsonb);
end $$;

-- ------------------------------------------------------------- look-ups ----
-- Both the reference and a contact detail must match. Holds and lapsed
-- holds are never returned: they are not bookings.
create or replace function public.find_booking(p_booking_ref text, p_contact text)
returns jsonb language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_ref     text := upper(btrim(coalesce(p_booking_ref, '')));
  v_contact text := lower(btrim(coalesce(p_contact, '')));
  v_digits  text := regexp_replace(coalesce(p_contact, ''), '[^0-9]', '', 'g');
begin
  if v_ref !~ '^MM-[A-Z0-9]{6}$' or v_contact = '' then return null; end if;
  if not exists (
    select 1 from public.reservations
     where booking_ref = v_ref
       and status not in ('held', 'expired')
       and (lower(guest_email) = v_contact
            or (char_length(v_digits) >= 10
                and right(regexp_replace(guest_phone, '[^0-9]', '', 'g'), 10) = right(v_digits, 10)))
  ) then
    return null;
  end if;
  return public.booking_json(v_ref);
end $$;

-- ================================================================= admin ====
-- Authorisation comes from the signed-in user's app_metadata, which only the
-- service role can set (scripts/create_admin.js). A guest cannot grant it to
-- themselves.
create or replace function public.is_admin()
returns boolean language sql stable
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'hotel_role') = 'admin', false)
$$;

create or replace function public.admin_availability(p_hotel_id text, p_check_in date, p_check_out date)
returns table (room_id uuid, room_number integer, room_type text, name text,
               price_per_night numeric, max_guests smallint, is_available boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select * from public.get_availability(p_hotel_id, p_check_in, p_check_out);
end $$;

-- Status changes, for every room of a booking at once. Only forward moves:
-- a cancelled booking is never silently revived, because its rooms may have
-- been sold since.
create or replace function public.admin_update_booking_status(p_booking_ref text, p_status text, p_reason text default null)
returns jsonb language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_from  text[];
  v_today date;
  n       integer;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;

  v_from := case p_status
    when 'checked_in'  then array['confirmed']
    when 'checked_out' then array['checked_in']
    when 'cancelled'   then array['confirmed', 'held']
    when 'no_show'     then array['confirmed']
    else null end;
  if v_from is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_status');
  end if;

  select (now() at time zone h.timezone)::date into v_today
    from public.reservations x join public.hotels h on h.id = x.hotel_id
   where x.booking_ref = p_booking_ref limit 1;
  if v_today is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  update public.reservations
     set status = p_status,
         cancelled_at  = case when p_status = 'cancelled' then now() else cancelled_at end,
         cancel_reason = case when p_status = 'cancelled' then left(nullif(btrim(p_reason), ''), 300) else cancel_reason end
   where booking_ref = p_booking_ref
     and status = any(v_from)
     and (p_status not in ('checked_in', 'no_show') or check_in <= v_today);
  get diagnostics n = row_count;

  if n = 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  end if;
  return jsonb_build_object('ok', true, 'updated', n, 'booking', public.booking_json(p_booking_ref));
end $$;

-- Revenue and occupancy from the reservations themselves. A night counts as
-- sold when a confirmed, in-house or completed stay covers it; revenue is the
-- rate that was actually booked for that night, not today's list price.
create or replace function public.admin_report(p_hotel_id text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_tz     text;
  v_rooms  integer;
  result   jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  select timezone into v_tz from public.hotels where id = p_hotel_id;
  select count(*) into v_rooms from public.rooms where hotel_id = p_hotel_id and is_active;

  with sold as (
    select d::date as night, x.room_type, x.price_per_night
      from public.reservations x
      cross join lateral generate_series(greatest(x.check_in, p_from), least(x.check_out - 1, p_to), interval '1 day') d
     where x.hotel_id = p_hotel_id
       and x.status in ('confirmed', 'checked_in', 'checked_out')
       and x.check_in <= p_to and x.check_out > p_from
  ),
  daily as (
    select g::date as night, count(s.night) as occupied, coalesce(sum(s.price_per_night), 0) as revenue
      from generate_series(p_from, p_to, interval '1 day') g
      left join sold s on s.night = g::date
     group by g::date
  ),
  by_type as (
    select room_type, count(*) as room_nights, sum(price_per_night) as revenue
      from sold group by room_type
  ),
  bookings as (
    select booking_ref, min(status) as status, min(created_at) as created_at,
           min(cancelled_at) as cancelled_at, sum(total_price) as total
      from public.reservations
     where hotel_id = p_hotel_id and status not in ('held', 'expired')
     group by booking_ref
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'days', p_to - p_from + 1,
    'active_rooms', v_rooms,
    'room_nights_sold', (select count(*) from sold),
    'room_revenue', (select coalesce(sum(price_per_night), 0) from sold),
    'daily', (select jsonb_agg(jsonb_build_object('date', night, 'occupied', occupied, 'revenue', revenue) order by night) from daily),
    'by_type', coalesce((select jsonb_agg(jsonb_build_object('room_type', room_type, 'room_nights', room_nights, 'revenue', revenue) order by room_type) from by_type), '[]'::jsonb),
    'bookings_made', (select count(*) from bookings
                       where (created_at at time zone v_tz)::date between p_from and p_to),
    'bookings_value', (select coalesce(sum(total), 0) from bookings
                       where status <> 'cancelled' and (created_at at time zone v_tz)::date between p_from and p_to),
    'cancellations', (select count(*) from bookings
                       where status = 'cancelled' and (cancelled_at at time zone v_tz)::date between p_from and p_to)
  ) into result;
  return result;
end $$;
