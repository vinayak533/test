-- ============================================================================
-- 004_security.sql — who may read and write what.
--
--   anon (the public key)    nothing: no table, no view, no function
--   authenticated, no staff  nothing (RLS returns zero rows; functions refuse)
--   staff of some hotels     read the four tables for those hotels only; edit
--                            their rooms' type, price, capacity, name and
--                            active flag, and their hotel's contact details;
--                            change a booking's status through
--                            admin_update_booking_status; agency_overview
--   service_role (server)    the guest-facing functions in 003
--
-- Which hotels: public.staff_hotel_ids() (003). An agency administrator
-- (app_metadata.hotel_role = 'admin') has every hotel; a hotel manager has
-- the hotels listed for them in hotel_staff. Both are writable only with the
-- service-role key, so nobody can promote themselves; scripts/create_admin.js
-- is how either is made. The scoping is in the database, so a manager asking
-- for another client's rows directly — not through the page — still gets
-- nothing.
-- ============================================================================

-- ------------------------------------------------------------- RLS on ----
alter table public.hotels       enable row level security;
alter table public.rooms        enable row level security;
alter table public.guests       enable row level security;
alter table public.reservations enable row level security;
alter table public.agencies     enable row level security;
alter table public.hotel_staff  enable row level security;

-- ------------------------------------------------------------- grants ----
revoke all on public.hotels, public.rooms, public.guests, public.reservations from anon, authenticated;
grant select on public.hotels, public.rooms, public.guests, public.reservations to authenticated;
grant update (room_type, price_per_night, max_guests, is_active, name) on public.rooms to authenticated;
-- A hotel's profile: contact details and description. Not its name or
-- aliases (the seeds own those, and the ChatBot matches guests' words to
-- them), nor its policy times, which the booking rules depend on.
grant update (description, address, phone, email) on public.hotels to authenticated;
grant select, insert, update, delete on public.hotels, public.rooms, public.guests, public.reservations to service_role;

revoke all on public.agencies, public.hotel_staff from anon, authenticated;
grant select on public.agencies, public.hotel_staff to authenticated;
grant select, insert, update, delete on public.agencies, public.hotel_staff to service_role;

-- Contact details are free text; keep them to something a guest can use,
-- whoever writes them.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hotels_profile_lengths') then
    alter table public.hotels add constraint hotels_profile_lengths check (
      coalesce(char_length(description), 0) <= 600 and coalesce(char_length(address), 0) <= 200 and
      coalesce(char_length(phone), 0) <= 40 and coalesce(char_length(email), 0) <= 254);
  end if;
end $$;

-- ----------------------------------------------------------- policies ----
-- `(select …)` has Postgres work the hotel list out once per query, not
-- once per row.
drop policy if exists hotels_admin_read on public.hotels;
create policy hotels_admin_read on public.hotels
  for select to authenticated using (id = any((select public.staff_hotel_ids())::text[]));

drop policy if exists hotels_admin_update on public.hotels;
create policy hotels_admin_update on public.hotels
  for update to authenticated
  using (id = any((select public.staff_hotel_ids())::text[]))
  with check (id = any((select public.staff_hotel_ids())::text[]));

drop policy if exists rooms_admin_read on public.rooms;
create policy rooms_admin_read on public.rooms
  for select to authenticated using (hotel_id = any((select public.staff_hotel_ids())::text[]));

drop policy if exists rooms_admin_update on public.rooms;
create policy rooms_admin_update on public.rooms
  for update to authenticated
  using (hotel_id = any((select public.staff_hotel_ids())::text[]))
  with check (hotel_id = any((select public.staff_hotel_ids())::text[]));

drop policy if exists guests_admin_read on public.guests;
create policy guests_admin_read on public.guests
  for select to authenticated using (hotel_id = any((select public.staff_hotel_ids())::text[]));

drop policy if exists reservations_admin_read on public.reservations;
create policy reservations_admin_read on public.reservations
  for select to authenticated using (hotel_id = any((select public.staff_hotel_ids())::text[]));

-- The agency: visible to anyone who manages one of its hotels.
drop policy if exists agencies_staff_read on public.agencies;
create policy agencies_staff_read on public.agencies
  for select to authenticated using (
    exists (select 1 from public.hotels h
             where h.agency_id = agencies.id and h.id = any((select public.staff_hotel_ids())::text[])));

-- Staff lists: an agency administrator sees them all, a manager their own.
drop policy if exists hotel_staff_read on public.hotel_staff;
create policy hotel_staff_read on public.hotel_staff
  for select to authenticated using ((select public.is_admin()) or user_id = (select auth.uid()));

-- ------------------------------------------------------------ guest view ---
-- Profile plus booking history totals. security_invoker makes the view obey
-- the caller's RLS, so it is as private as the tables beneath it.
create or replace view public.guest_summaries with (security_invoker = true) as
select g.id, g.hotel_id, g.full_name, g.email, g.phone, g.created_at,
       count(distinct x.booking_ref) filter (where x.status not in ('held', 'expired'))                 as bookings,
       count(distinct x.booking_ref) filter (where x.status = 'cancelled')                              as cancelled,
       coalesce(sum(x.total_price) filter (where x.status in ('confirmed', 'checked_in', 'checked_out')), 0) as total_spend,
       max(x.check_out) filter (where x.status in ('confirmed', 'checked_in', 'checked_out'))           as last_stay,
       min(x.check_in)  filter (where x.status = 'confirmed' and x.check_in >= current_date)           as next_stay
  from public.guests g
  left join public.reservations x on x.guest_id = g.id
 group by g.id;

revoke all on public.guest_summaries from anon, authenticated;
grant select on public.guest_summaries to authenticated;

-- ---------------------------------------------------------- functions ----
-- Postgres grants EXECUTE to PUBLIC by default; take it away everywhere and
-- give it back only where it is meant to be.
revoke execute on function public.new_booking_ref()                                   from public, anon, authenticated;
revoke execute on function public.booking_json(text)                                  from public, anon, authenticated;
revoke execute on function public.sweep_expired_holds(uuid[])                         from public, anon, authenticated;
revoke execute on function public.get_availability(text, date, date)                  from public, anon, authenticated;
revoke execute on function public.hold_rooms(text, uuid[], integer[], date, date, time, time, text) from public, anon, authenticated;
revoke execute on function public.release_hold(text, text)                            from public, anon, authenticated;
revoke execute on function public.confirm_booking(text, text, text, text, text, time, time, uuid) from public, anon, authenticated;
revoke execute on function public.find_booking(text, text)                            from public, anon, authenticated;
revoke execute on function public.touch_updated_at()                                  from public, anon, authenticated;

grant execute on function public.sweep_expired_holds(uuid[])                          to service_role;
grant execute on function public.get_availability(text, date, date)                   to service_role;
grant execute on function public.hold_rooms(text, uuid[], integer[], date, date, time, time, text) to service_role;
grant execute on function public.release_hold(text, text)                             to service_role;
grant execute on function public.confirm_booking(text, text, text, text, text, time, time, uuid) to service_role;
grant execute on function public.find_booking(text, text)                             to service_role;

-- Admin functions check staff_hotel_ids() themselves; anon still cannot reach them.
revoke execute on function public.is_admin()                                          from public, anon;
revoke execute on function public.staff_hotel_ids()                                   from public, anon;
revoke execute on function public.can_manage_hotel(text)                              from public, anon;
revoke execute on function public.agency_overview()                                   from public, anon;
revoke execute on function public.admin_availability(text, date, date)                from public, anon;
revoke execute on function public.admin_update_booking_status(text, text, text)       from public, anon;
revoke execute on function public.admin_report(text, date, date)                      from public, anon;
grant execute on function public.is_admin()                                           to authenticated, service_role;
grant execute on function public.staff_hotel_ids()                                    to authenticated, service_role;
grant execute on function public.can_manage_hotel(text)                               to authenticated, service_role;
grant execute on function public.agency_overview()                                    to authenticated;
grant execute on function public.admin_availability(text, date, date)                 to authenticated;
grant execute on function public.admin_update_booking_status(text, text, text)        to authenticated;
grant execute on function public.admin_report(text, date, date)                       to authenticated;

-- ----------------------------------------------------------- realtime ----
-- The dashboard listens for new bookings and room edits. Realtime applies
-- the same RLS, so staff receive only their own hotels' rows.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reservations') then
      alter publication supabase_realtime add table public.reservations;
    end if;
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms') then
      alter publication supabase_realtime add table public.rooms;
    end if;
  end if;
end $$;
