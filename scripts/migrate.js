/* ============================================================================
   scripts/migrate.js — apply supabase/migrations/*.sql in filename order.

       npm run db:migrate              apply, then print what the seed left
       npm run db:migrate -- --dry-run apply everything inside one transaction,
                                       print the result, then roll it all back

   Uses SUPABASE_DB_POOLER_URL (IPv4) when set, else SUPABASE_DB_URL. Every
   migration is idempotent, so re-running is safe. Each file runs in its own
   transaction and the script stops at the first failure.
   ============================================================================ */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const DIR = path.join(__dirname, "..", "supabase", "migrations");
const DRY = process.argv.includes("--dry-run");

async function summary(client){
  const hotels = await client.query("select id, name from public.hotels order by id");
  const rooms = await client.query(`
    select hotel_id, room_type, count(*)::int as rooms, min(room_number) as first, max(room_number) as last,
           min(price_per_night)::text as min_price, max(price_per_night)::text as max_price
      from public.rooms group by hotel_id, room_type order by hotel_id, room_type`);
  const res = await client.query("select count(*)::int n from public.reservations");
  console.log("\nhotels:       " + hotels.rows.map(h => `${h.id} (${h.name})`).join(", "));
  for (const r of rooms.rows){
    console.log(`rooms:        ${r.hotel_id.padEnd(18)} ${r.room_type.padEnd(7)} ${r.rooms} × rooms ${r.first}–${r.last}  ₹${r.min_price}${r.min_price === r.max_price ? "" : "–" + r.max_price}`);
  }
  console.log("reservations: " + res.rows[0].n);
}

async function main(){
  const url = process.env.SUPABASE_DB_POOLER_URL || process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("Set SUPABASE_DB_POOLER_URL or SUPABASE_DB_URL in .env");

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    if (DRY) await client.query("begin");
    for (const file of fs.readdirSync(DIR).filter(f => f.endsWith(".sql")).sort()){
      const sql = fs.readFileSync(path.join(DIR, file), "utf8");
      process.stdout.write("apply " + file + " ... ");
      if (!DRY) await client.query("begin");
      try {
        await client.query(sql);
        if (!DRY) await client.query("commit");
        console.log("ok");
      } catch (e){
        await client.query("rollback");
        console.log("FAILED");
        throw e;
      }
    }
    await summary(client);
    if (DRY){
      await client.query("rollback");
      console.log("\n(dry run — everything above was rolled back)");
    }
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
