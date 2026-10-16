/* ============================================================================
   server/db/repository.js — every Supabase call the ChatBot makes.

   Runs with the service-role key, server side only. Reads are two plain
   selects (hotels, rooms); everything that touches reservations goes through
   the database functions in supabase/migrations/003_booking_functions.sql,
   which validate again and run as one transaction each. Every call is bounded
   by SUPABASE_TIMEOUT_MS. Any failure throws DataError — callers must never
   turn a failure into a number or a "booked".
   ============================================================================ */

"use strict";

const { createClient } = require("@supabase/supabase-js");

class DataError extends Error {
  constructor(message, cause){ super(message); this.cause = cause; }
}

function createSupabase({ supabaseUrl, supabaseServiceKey, dbTimeoutMs }){
  if (!supabaseUrl || !supabaseServiceKey) throw new DataError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(dbTimeoutMs) }),
      headers: { "X-Client-Info": "misty-chatbot" }
    }
  });
}

function rows({ data, error }, what){
  if (error) throw new DataError(`${what} failed: ${error.message || error.code || "unknown error"}`, error);
  if (!Array.isArray(data)) throw new DataError(`${what} returned no rows array`);
  return data;
}
function value({ data, error }, what){
  if (error) throw new DataError(`${what} failed: ${error.message || error.code || "unknown error"}`, error);
  return data;
}
async function call(promise, what){
  try { return await promise; }
  catch (e){ throw new DataError(`${what} failed: ${e.message}`, e); }
}

const num = v => Number(v);
const hhmm = t => (typeof t === "string" ? t.slice(0, 5) : t);

function createRepository(supabase, { hotelCacheMs = 60 * 1000 } = {}){
  let hotelCache = null;

  return {
    /* Active hotels, cached briefly: needed on every turn. */
    async listHotels(){
      if (hotelCache && Date.now() - hotelCache.at < hotelCacheMs) return hotelCache.rows;
      const data = rows(await call(supabase.from("hotels")
        .select("id, name, aliases, address, phone, timezone, currency, check_in_time, check_out_time, hold_minutes, max_stay_nights")
        .eq("is_active", true)
        .order("id"), "hotels query"), "hotels query");
      const out = data.map(h => ({ ...h, check_in_time: hhmm(h.check_in_time), check_out_time: hhmm(h.check_out_time) }));
      hotelCache = { at: Date.now(), rows: out };
      return out;
    },

    /* Active rooms: types, rates and capacity, never cached — an admin may
       have just changed a price. */
    async getRooms(hotelId){
      return rows(await call(supabase.from("rooms")
        .select("id, room_number, room_type, price_per_night, max_guests")
        .eq("hotel_id", hotelId)
        .eq("is_active", true)
        .order("room_number"), "rooms query"), "rooms query")
        .map(r => ({ ...r, price_per_night: num(r.price_per_night) }));
    },

    async getAvailability(hotelId, checkIn, checkOut){
      return rows(await call(supabase.rpc("get_availability",
        { p_hotel_id: hotelId, p_check_in: checkIn, p_check_out: checkOut }), "availability"), "availability")
        .map(r => ({ ...r, price_per_night: num(r.price_per_night) }));
    },

    async holdRooms({ hotelId, roomIds, guests, checkIn, checkOut, arrival, departure, tokenHash }){
      return value(await call(supabase.rpc("hold_rooms", {
        p_hotel_id: hotelId, p_room_ids: roomIds, p_guests: guests,
        p_check_in: checkIn, p_check_out: checkOut,
        p_arrival_time: arrival || null, p_departure_time: departure || null,
        p_token_hash: tokenHash
      }), "hold"), "hold");
    },

    async confirmBooking({ ref, tokenHash, name, email, phone, arrival, departure, userId }){
      return value(await call(supabase.rpc("confirm_booking", {
        p_booking_ref: ref, p_token_hash: tokenHash,
        p_guest_name: name, p_guest_email: email, p_guest_phone: phone,
        p_arrival_time: arrival || null, p_departure_time: departure || null,
        p_user_id: userId || null
      }), "confirm"), "confirm");
    },

    /* The guest behind an access token, checked by Supabase Auth itself —
       never decoded and trusted here. null for a missing, expired or forged
       token; throws DataError only when Auth cannot be reached. */
    async getUser(accessToken){
      if (!accessToken) return null;
      let out;
      try { out = await supabase.auth.getUser(accessToken); }
      catch (e){ throw new DataError(`auth check failed: ${e.message}`, e); }
      const { data, error } = out;
      if (error){
        if (error.status && error.status >= 500) throw new DataError(`auth check failed: ${error.message}`, error);
        return null;
      }
      const u = data && data.user;
      if (!u || !u.id) return null;
      const meta = u.user_metadata || {};
      return { id: u.id, email: u.email || "", name: typeof meta.full_name === "string" ? meta.full_name : "" };
    },

    async releaseHold(ref, tokenHash){
      return value(await call(supabase.rpc("release_hold", { p_booking_ref: ref, p_token_hash: tokenHash }), "release"), "release");
    },

    async findBooking(ref, contact){
      return value(await call(supabase.rpc("find_booking", { p_booking_ref: ref, p_contact: contact }), "lookup"), "lookup");
    }
  };
}

module.exports = { createSupabase, createRepository, DataError };
