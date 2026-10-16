/* ============================================================================
   scripts/inspect_schema.js — print the public schema, RLS state and row
   counts, and prove the anon key cannot read the tables.

       npm run db:inspect
   ============================================================================ */

const { Client } = require("pg");

async function main(){
  const url = process.env.SUPABASE_DB_POOLER_URL || process.env.SUPABASE_DB_URL;
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const cols = await client.query(`
      select c.table_name, c.column_name, c.data_type, c.is_nullable
      from information_schema.columns c
      where c.table_schema = 'public'
      order by c.table_name, c.ordinal_position`);
    let current = null;
    for (const r of cols.rows){
      if (r.table_name !== current){ current = r.table_name; console.log("\n" + current); }
      console.log("  " + r.column_name.padEnd(14) + r.data_type + (r.is_nullable === "NO" ? "  not null" : ""));
    }

    const rls = await client.query(`
      select relname, relrowsecurity
      from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`);
    console.log("\nRLS");
    for (const r of rls.rows){
      const n = await client.query(`select count(*)::int n from public.${client.escapeIdentifier(r.relname)}`);
      console.log("  " + r.relname.padEnd(14) + (r.relrowsecurity ? "enabled " : "DISABLED") + "  rows=" + n.rows[0].n);
    }
  } finally {
    await client.end();
  }

  // What the public internet sees with the anon key.
  const res = await fetch(process.env.SUPABASE_URL + "/rest/v1/reservations?select=guest_name&limit=1", {
    headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: "Bearer " + process.env.SUPABASE_ANON_KEY }
  });
  const body = await res.text();
  console.log("\nanon read of reservations: HTTP " + res.status + " " + body.slice(0, 120));
}

main().catch(e => { console.error(e.message); process.exit(1); });
