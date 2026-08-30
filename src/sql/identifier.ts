// Writing the parts of a query that cannot be parameterized.

/** Quote an identifier for use in a query; treat them as names, not commands. */
export const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
