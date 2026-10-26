// Small helpers on text, shared by the screens.

/** e.g. `count(1, 'registro')` -> "1 registro", `count(2, 'acción', 'acciones')` -> "2 acciones". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** e.g. "2026-09-30 15:37:08.123" -> "2026-09-30 15:37" */
export const toMinute = (at: string) => at.slice(0, 16);

/** e.g. "2026-09-30 15:37:08.123" -> "2026-09-30 15:37:08" */
export const toSecond = (at: string) => at.slice(0, 19);

/** Same values in the same order, e.g. two record keys. */
export const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
