-- ============================================================================
-- 004_security.sql — who may read and write what.
--
--   anon (the public key)    nothing: no table, no view, no function
--   authenticated, not admin nothing (RLS returns zero rows; functions refuse)
--   authenticated admin      read all four tables; edit a room's type, price,
--                            capacity, name and active flag; change a
--                            booking's status through admin_update_booking_status
--   service_role (server)    the guest-facing functions in 003
--
-- An admin is a Supabase Auth user whose app_metadata.hotel_role is 'admin'.
-- app_metadata is writable only with the service-role key, so nobody can
-- promote themselves; scripts/create_admin.js is how one is made.
-- ============================================================================

-- ------------------------------------------------------------- RLS on ----
alter table public.hotels       enable row level security;
alter table public.rooms        enable row level security;
alter table public.guests       enable row level security;
alter table public.reservations enable row level security;

-- ------------------------------------------------------------- grants ----
revoke all on public.hotels, public.rooms, public.guests, public.reservations from anon, authenticated;
grant select on public.hotels, public.rooms, public.guests, public.reservations to authenticated;
grant update (room_type, price_per_night, max_guests, is_active, name) on public.rooms to authenticated;
grant select, insert, update, delete on public.hotels, public.rooms, public.guests, public.reservations to service_role;

-- ----------------------------------------------------------- policies ----
drop policy if exists hotels_admin_read on public.hotels;
create policy hotels_admin_read on public.hotels
  for select to authenticated using (public.is_admin());

drop policy if exists rooms_admin_read on public.rooms;
create policy rooms_admin_read on public.rooms
  for select to authenticated using (public.is_admin());

drop policy if exists rooms_admin_update on public.rooms;
create policy rooms_admin_update on public.rooms
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists guests_admin_read on public.guests;
create policy guests_admin_read on public.guests
  for select to authenticated using (public.is_admin());

drop policy if exists reservations_admin_read on public.reservations;
create policy reservations_admin_read on public.reservations
  for select to authenticated using (public.is_admin());

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

-- Admin functions check is_admin() themselves; anon still cannot reach them.
revoke execute on function public.is_admin()                                          from public, anon;
revoke execute on function public.admin_availability(text, date, date)                from public, anon;
revoke execute on function public.admin_update_booking_status(text, text, text)       from public, anon;
revoke execute on function public.admin_report(text, date, date)                      from public, anon;
grant execute on function public.is_admin()                                           to authenticated, service_role;
grant execute on function public.admin_availability(text, date, date)                 to authenticated;
grant execute on function public.admin_update_booking_status(text, text, text)        to authenticated;
grant execute on function public.admin_report(text, date, date)                       to authenticated;

-- ----------------------------------------------------------- realtime ----
-- The dashboard listens for new bookings and room edits. Realtime applies
-- the same RLS, so only admins receive the rows.
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
