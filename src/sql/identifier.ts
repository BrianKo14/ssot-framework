// Writing the parts of a query that cannot be parameterized.

import type { ColumnInfo } from '../schema/model.js';

/** Quote an identifier for use in a query; treat them as names, not commands. */
export const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** List of column names -> comma-separated string for SQL. */
export const columnList = (cols: ColumnInfo[]) => cols.map(c => q(c.name)).join(', ');
