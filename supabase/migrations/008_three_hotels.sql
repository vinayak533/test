-- ============================================================================
-- 008_three_hotels.sql — Misty Mountain, Royal Hotel and Taj Hotel, all live.
--
-- The front-desk assistant serves all three client hotels, so Royal Hotel
-- and Taj Hotel (006), switched off by 007, are switched back on. Their rooms,
-- rates and any history were kept by 007, so nothing else changes: each hotel
-- still has its own inventory, prices and bookings, and every lookup and
-- booking function stays keyed by hotel_id.
--
-- Safe to re-run. 007 runs just before this file on every migrate and turns
-- them off; this turns them on again, so the end state is always all three.
-- ============================================================================

update public.hotels
   set is_active = true, updated_at = now()
 where id in ('royal_kuttikkanam', 'taj_kuttikkanam')
   and not is_active;
