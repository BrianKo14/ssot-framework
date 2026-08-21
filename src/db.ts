// Wrapper exposing a minimal query/close interface for the rest of the app

import pg from 'pg';

export interface Db {
  query<T extends pg.QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function connect(databaseUrl: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: databaseUrl });		// create a pool of connections to the database to use on request
  await pool.query('select 1');          		       		// runs a trivial test query

  return {
    async query(text, params) {
      const r = await pool.query(text, params as never[]);
      return r.rows as never[];
    },
    close: () => pool.end(),
  };
}