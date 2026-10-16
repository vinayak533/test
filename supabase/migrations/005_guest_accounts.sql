-- ============================================================================
-- 005_guest_accounts.sql — signed-in guests: live room board, their own
-- bookings, cancelling, and a change signal the page can listen to.
--
-- Guests register with Supabase Auth (email + password). Authentication stays
-- in auth.users; nothing here copies passwords or profiles. A guest account
-- has no app_metadata.hotel_role, so every admin policy and function in 004
-- still refuses it.
--
--   room_board(hotel, check_in, check_out)
--                     every room with its type, rate and status for those
--                     nights: available | booked | held | inactive. No guest
--                     names or contact details — any signed-in user may call it.
--   my_bookings()     the caller's own bookings (reservations.user_id)
--   cancel_my_booking(ref)
--                     the caller cancels one of their own confirmed bookings
--                     before its check-in day; the rooms free up at once
--   inventory_pulse   one row per hotel, touched whenever a reservation or a
--                     room changes. It carries no booking data: it only tells
--                     a signed-in page "something changed, read room_board
--                     again". Realtime on reservations itself stays admin-only.
--
-- Status rules are the ones get_availability uses (003):
--   booked    confirmed or checked_in, overlapping the nights asked about
--   held      a live hold (not yet past hold_expires_at)
-- ============================================================================

-- ---------------------------------------------------------- room board ----
create or replace function public.room_board(p_hotel_id text, p_check_in date, p_check_out date)
returns table (room_id uuid, room_number integer, room_type text, name text,
               price_per_night numeric, max_guests smallint, is_active boolean,
               status text, mine boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in or p_check_out - p_check_in > 366 then
    raise exception 'invalid_dates' using errcode = '22023';
  end if;
  return query
    with live as (
      select x.room_id, x.status, x.user_id
        from public.reservations x
       where x.hotel_id = p_hotel_id
         and x.stay && daterange(p_check_in, p_check_out, '[)')
         and (x.status in ('confirmed', 'checked_in')
              or (x.status = 'held' and x.hold_expires_at > now()))
    )
    select r.id, r.room_number, r.room_type, r.name, r.price_per_night, r.max_guests, r.is_active,
           case
             when not r.is_active then 'inactive'
             when exists (select 1 from live l where l.room_id = r.id and l.status in ('confirmed', 'checked_in')) then 'booked'
             when exists (select 1 from live l where l.room_id = r.id) then 'held'
             else 'available'
           end,
           exists (select 1 from live l where l.room_id = r.id and l.user_id = auth.uid()
                     and l.status in ('confirmed', 'checked_in'))
      from public.rooms r
      join public.hotels h on h.id = r.hotel_id and h.is_active
     where r.hotel_id = p_hotel_id
     order by r.room_number;
end $$;

-- --------------------------------------------------------- my bookings ----
create or replace function public.my_bookings()
returns jsonb language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(b.doc order by b.check_in desc, b.ref), '[]'::jsonb)
    from (
      select x.booking_ref as ref, min(x.check_in) as check_in, public.booking_json(x.booking_ref) as doc
        from public.reservations x
       where auth.uid() is not null
         and x.user_id = auth.uid()
         and x.status not in ('held', 'expired')
       group by x.booking_ref
    ) b
$$;

-- --------------------------------------------------------- cancelling ----
-- A guest may cancel their own confirmed booking up to the day before
-- check-in (hotel time). On the day itself, or once checked in, it is a
-- matter for the front desk.
create or replace function public.cancel_my_booking(p_booking_ref text)
returns jsonb language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_ref     text := upper(btrim(coalesce(p_booking_ref, '')));
  v_total   integer;
  v_live    integer;
  v_in      date;
  v_today   date;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;

  perform 1 from public.reservations where booking_ref = v_ref and user_id = v_uid order by id for update;

  select count(*), count(*) filter (where x.status = 'confirmed'), min(x.check_in),
         min((now() at time zone h.timezone)::date)
    into v_total, v_live, v_in, v_today
    from public.reservations x join public.hotels h on h.id = x.hotel_id
   where x.booking_ref = v_ref and x.user_id = v_uid;

  if v_total = 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_live <> v_total then
    return jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  end if;
  if v_in <= v_today then
    return jsonb_build_object('ok', false, 'reason', 'too_late');
  end if;

  update public.reservations
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelled by the guest'
   where booking_ref = v_ref and user_id = v_uid and status = 'confirmed';

  return jsonb_build_object('ok', true, 'booking', public.booking_json(v_ref));
end $$;

-- ---------------------------------------------------- inventory pulse ----
create table if not exists public.inventory_pulse (
  hotel_id    text primary key references public.hotels(id) on delete cascade,
  changed_at  timestamptz not null default now()
);

create or replace function public.bump_inventory_pulse()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare v_hotel text;
begin
  v_hotel := case when tg_op = 'DELETE' then old.hotel_id else new.hotel_id end;
  insert into public.inventory_pulse (hotel_id, changed_at) values (v_hotel, now())
  on conflict (hotel_id) do update set changed_at = excluded.changed_at;
  return null;
end $$;

drop trigger if exists reservations_pulse on public.reservations;
create trigger reservations_pulse after insert or update or delete on public.reservations
  for each row execute function public.bump_inventory_pulse();

drop trigger if exists rooms_pulse on public.rooms;
create trigger rooms_pulse after insert or update or delete on public.rooms
  for each row execute function public.bump_inventory_pulse();

insert into public.inventory_pulse (hotel_id) select id from public.hotels on conflict do nothing;

alter table public.inventory_pulse enable row level security;
revoke all on public.inventory_pulse from anon, authenticated;
grant select on public.inventory_pulse to authenticated;
grant select, insert, update, delete on public.inventory_pulse to service_role;

drop policy if exists inventory_pulse_signed_in_read on public.inventory_pulse;
create policy inventory_pulse_signed_in_read on public.inventory_pulse
  for select to authenticated using (true);

-- ---------------------------------------------------------- functions ----
revoke execute on function public.room_board(text, date, date)   from public, anon;
revoke execute on function public.my_bookings()                  from public, anon;
revoke execute on function public.cancel_my_booking(text)        from public, anon;
revoke execute on function public.bump_inventory_pulse()         from public, anon, authenticated;
grant execute on function public.room_board(text, date, date)    to authenticated;
grant execute on function public.my_bookings()                   to authenticated;
grant execute on function public.cancel_my_booking(text)         to authenticated;

-- ----------------------------------------------------------- realtime ----
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'inventory_pulse') then
    alter publication supabase_realtime add table public.inventory_pulse;
  end if;
end $$;
