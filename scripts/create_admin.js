/* ============================================================================
   scripts/create_admin.js — grant (or revoke) dashboard access.

       npm run admin:create -- owner@example.com                      agency administrator
       npm run admin:create -- owner@example.com --revoke
       npm run admin:create -- desk@example.com --hotel royal_kuttikkanam   that hotel only
       npm run admin:create -- desk@example.com --hotel royal_kuttikkanam --revoke

   Agency administrator: app_metadata.hotel_role = "admin" — every client
   hotel, and the agency overview across them.

   Hotel manager (--hotel <id>): a row in public.hotel_staff for that hotel,
   and app_metadata.hotel_role = "manager" so the page opens the dashboard
   instead of the guest area. The database scopes every read and write to the
   hotels in hotel_staff (supabase/migrations/004_security.sql), so a manager
   never sees another client's data. Run it again with another --hotel to
   give one person a second hotel.

   app_metadata and hotel_staff can only be written with the service-role
   key, so this is the only way anyone gets either.

   Password: taken from ADMIN_PASSWORD if set (at least 12 characters),
   otherwise a strong one is generated and printed once. Existing users keep
   their password. A change of role travels inside the access token, so a
   user already signed in must sign in again to see a different screen;
   removing a hotel from a manager takes effect on their next request.
   ============================================================================ */

"use strict";

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

async function findUser(admin, email){
  for (let page = 1; page < 50; page++){
    const { data, error } = await admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find(u => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

function arg(name){
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] || "") : null;
}

async function setRole(admin, user, role){
  const meta = { ...(user.app_metadata || {}) };
  if (role) meta.hotel_role = role; else delete meta.hotel_role;
  const { error } = await admin.updateUserById(user.id, { app_metadata: meta });
  if (error) throw error;
}

async function main(){
  const hotelId = arg("--hotel");
  const email = (process.argv.slice(2).find(a => !a.startsWith("--") && a !== hotelId) || "").trim().toLowerCase();
  const revoke = process.argv.includes("--revoke");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Usage: npm run admin:create -- someone@example.com [--hotel <hotel id>] [--revoke]");
  if (hotelId !== null && !/^[a-z0-9_]{2,40}$/.test(hotelId)) throw new Error("--hotel needs a hotel id, e.g. --hotel royal_kuttikkanam");
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const admin = supabase.auth.admin;

  let hotel = null;
  if (hotelId){
    const { data, error } = await supabase.from("hotels").select("id, name").eq("id", hotelId);
    if (error) throw error;
    if (!data.length){
      const { data: all } = await supabase.from("hotels").select("id").order("id");
      throw new Error(`No hotel "${hotelId}". Hotels: ${(all || []).map(h => h.id).join(", ")}`);
    }
    hotel = data[0];
  }

  const existing = await findUser(admin, email);

  if (revoke){
    if (!existing){ console.log(`${email} has no account; nothing to revoke.`); return; }
    if (hotel){
      const { error } = await supabase.from("hotel_staff").delete().eq("user_id", existing.id).eq("hotel_id", hotel.id);
      if (error) throw error;
      const { data: left, error: e2 } = await supabase.from("hotel_staff").select("hotel_id").eq("user_id", existing.id);
      if (e2) throw e2;
      if (!left.length && (existing.app_metadata || {}).hotel_role === "manager") await setRole(admin, existing, null);
      console.log(`${email} no longer manages ${hotel.name}.` + (left.length ? ` Still manages: ${left.map(x => x.hotel_id).join(", ")}.` : ""));
      return;
    }
    await setRole(admin, existing, null);
    const { error } = await supabase.from("hotel_staff").delete().eq("user_id", existing.id);
    if (error) throw error;
    console.log(`Dashboard access revoked for ${email}. It ends when their current session token expires (at most an hour), or at once if they sign out.`);
    return;
  }

  let user = existing, password = null;
  if (!user){
    password = process.env.ADMIN_PASSWORD || "";
    if (!password) password = crypto.randomBytes(18).toString("base64url");
    if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
    const { data, error } = await admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    user = data.user;
  }

  if (hotel){
    const { error } = await supabase.from("hotel_staff").upsert({ user_id: user.id, hotel_id: hotel.id }, { onConflict: "user_id,hotel_id" });
    if (error) throw error;
    // An agency administrator already sees every hotel; never demote one.
    if ((user.app_metadata || {}).hotel_role !== "admin") await setRole(admin, user, "manager");
    console.log(`${email} ${existing ? "already had an account; it" : "was created and"} now manages ${hotel.name} (${hotel.id}).`);
  } else {
    await setRole(admin, user, "admin");
    console.log(`${email} ${existing ? "already had an account; it" : "was created and"} now has agency-wide dashboard access.`);
  }
  if (password && !process.env.ADMIN_PASSWORD) console.log(`Temporary password (shown once — store it in a password manager): ${password}`);
  else if (existing) console.log("Their password is unchanged.");
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
