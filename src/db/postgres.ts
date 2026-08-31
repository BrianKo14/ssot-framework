// Wrapper exposing a minimal query/close interface for the rest of the app

import pg from 'pg';
import { HttpError } from '../errors.js';

export interface Db {
  query<T extends pg.QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

// --- Error translation ---

const INTEGRITY_STATUS = new Map([
  ['23503', 409],       // foreign_key_violation
  ['23505', 409],       // unique_violation
  ['23502', 400],       // not_null_violation
  ['23514', 400],       // check_violation
]);

const asHttpError = (err: unknown): unknown => {
  if (!(err instanceof pg.DatabaseError)) return err;

  const status = INTEGRITY_STATUS.get(err.code ?? '');

  return status === undefined ? err : new HttpError(status, `violates constraint "${err.constraint}"`);
};



// --- CONNECTION ---

export async function connect(databaseUrl: string): Promise<Db> {

  // Create a pool of connections to the database to use on request
  const pool = new pg.Pool({
    connectionString: databaseUrl,

    // The driver defaults to parsing into JS types, but that causes problems, esp. with dates and intervals.
    // Instead, we read the text of every column as a string and let the type handlers read it.
    types: { getTypeParser: () => (value: string) => value },

    // Set format standards for the sessions
    options: '-c datestyle=ISO,YMD -c intervalstyle=iso_8601 -c timezone=UTC',
  });

  await pool.query('select 1');          		       		            // runs a trivial test query

  return {
    async query(text, params) {
      try {
        const r = await pool.query(text, params as never[]);
        return r.rows as never[];
      } catch (err) { throw asHttpError(err); }
    },
    close: () => pool.end(),
  };
}