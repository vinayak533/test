-- ============================================================================
-- 007_misty_mountain_only.sql — the platform serves Misty Mountain alone.
--
-- Royal Hotel and Taj Hotel (006) are taken off the platform by switching
-- them off, not by deleting them: an inactive hotel is listed nowhere — not
-- in the ChatBot, the guest area or the dashboard — and cannot be booked, as
-- every hotel lookup reads active hotels only. Their rooms, staff links and
-- any history stay in place, so turning one back on is a single update:
--
--   update public.hotels set is_active = true where id = 'royal_kuttikkanam';
--
-- Safe to re-run. 006 re-runs before this file and never touches is_active,
-- so the two hotels stay off however often the migrations are applied.
-- ============================================================================

update public.hotels
   set is_active = false, updated_at = now()
 where id in ('royal_kuttikkanam', 'taj_kuttikkanam')
   and is_active;
