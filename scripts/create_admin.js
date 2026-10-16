/* ============================================================================
   scripts/create_admin.js — grant (or revoke) dashboard access.

       npm run admin:create -- manager@example.com
       npm run admin:create -- manager@example.com --revoke

   Creates the Supabase Auth user if it does not exist and sets
   app_metadata.hotel_role = "admin", which is what the RLS policies check.
   app_metadata can only be written with the service-role key, so this is
   the only way anyone becomes an admin.

   Password: taken from ADMIN_PASSWORD if set (at least 12 characters),
   otherwise a strong one is generated and printed once. Existing users keep
   their password. A user already signed in must sign in again for a change
   in rights to take effect (the role travels inside their access token).
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

async function main(){
  const email = (process.argv.slice(2).find(a => !a.startsWith("--")) || "").trim().toLowerCase();
  const revoke = process.argv.includes("--revoke");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Usage: npm run admin:create -- someone@example.com [--revoke]");
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const admin = supabase.auth.admin;
  const existing = await findUser(admin, email);

  if (revoke){
    if (!existing){ console.log(`${email} has no account; nothing to revoke.`); return; }
    const meta = { ...(existing.app_metadata || {}) };
    delete meta.hotel_role;
    const { error } = await admin.updateUserById(existing.id, { app_metadata: meta });
    if (error) throw error;
    console.log(`Dashboard access revoked for ${email}. It ends when their current session token expires (at most an hour), or at once if they sign out.`);
    return;
  }

  if (existing){
    const { error } = await admin.updateUserById(existing.id, { app_metadata: { ...(existing.app_metadata || {}), hotel_role: "admin" } });
    if (error) throw error;
    console.log(`${email} already had an account; it now has dashboard access. Their password is unchanged.`);
    return;
  }

  let password = process.env.ADMIN_PASSWORD || "";
  const generated = !password;
  if (generated) password = crypto.randomBytes(18).toString("base64url");
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");

  const { error } = await admin.createUser({ email, password, email_confirm: true, app_metadata: { hotel_role: "admin" } });
  if (error) throw error;
  console.log(`Created ${email} with dashboard access.`);
  if (generated) console.log(`Temporary password (shown once — store it in a password manager): ${password}`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
