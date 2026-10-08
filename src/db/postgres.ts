// Wrapper exposing a minimal query/close interface for the rest of the app

import pg from 'pg';
import { HttpError } from '../errors.js';

/** A row as the driver answers it. */
export type Row = pg.QueryResultRow;

export interface Db {
  query<T extends Row>(text: string, params?: unknown[]): Promise<T[]>;
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



// --- Reading a statement back ---

/** Converts a string to a SQL literal.
 * One value per line (line breaks are escaped). */
const textLiteral = (s: string): string => /[\n\r]/.test(s)
  ? `E'${s.replace(/[\\']/g, m => m + m).replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`
  : pg.escapeLiteral(s);

/** Converts a value to a string representation that can be used in a SQL query. */
export const literal = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array[${value.map(literal).join(', ')}]`;

  return textLiteral(typeof value === 'string' ? value : JSON.stringify(value));
};

/** A SQL statement with its values inserted in place of placeholders.
 * E.g. `withValues('select * from t where a = $1 and b = $2', [1, 'x'])` */
export const withValues = (text: string, params: unknown[] = []): string =>
  text.replace(/\$(\d+)/g, (placeholder, n: string) => (Number(n) <= params.length ? literal(params[Number(n) - 1]) : placeholder));



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