import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initPool() first.');
  }
  return pool;
}

export function initPool(connectionString: string): pg.Pool {
  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
    // Force IPv4 — GCP VMs may not have IPv6 routing to Supabase
    family: 4,
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
