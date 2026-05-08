import pg from 'pg';
const url = 'postgresql://postgres.avazmxaailcorkbukjkn:Ipod6-Shrunk3-Policy8-Entering0-Dainty5@aws-1-us-east-2.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
const r = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
console.log(r.rows.map(x => x.tablename).join('\n'));
await pool.end();
