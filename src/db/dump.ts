// Dump of statements that didn't roll back

import { createWriteStream, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { type Db, type Row, withValues } from './postgres.js';

/** One statement as the dump writes it. */
export interface Written {
	/** When its answer arrived, by this process's clock (ISO-8601, UTC). */
	at: string;
	statement: string;
}

export interface Dump {
	/** The connection, every statement that takes effect on it written down. */
	db: Db;
	/** Everything written down so far, oldest first, read back from the file. */
	written(): Promise<Written[]>;
}

/** The line written before each statement. */
const header = (at: string) => `-- ${at}\n`;
const HEADER = /^-- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\n/m;

/** What closes each statement, makes the file a script. */
const END = ';\n';

/** Database wrapper so every successful statement is appeneded to the file at `path`. */
export function dumpTo(db: Db, path: string): Dump {
	const out = createWriteStream(path, { fd: openSync(path, 'a') });

	out.on('error', err => console.error(err));

	return {
		db: {
			async query<T extends Row>(text: string, params?: unknown[]) {
				const rows = await db.query<T>(text, params);
				// The time is this process's, when the answer arrived
				out.write(`${header(new Date().toISOString())}${withValues(text, params)}${END}`);
				return rows;
			},
			async close() {
				await db.close();
				await new Promise<void>(resolve => out.end(resolve));
			},
		},

		/** List of all the statements that have been written to the dump file. */
		async written() {
			const [, ...parts] = (await readFile(path, 'utf8')).split(HEADER);
			const all: Written[] = [];

			for (let i = 0; i + 1 < parts.length; i += 2)
				if (parts[i + 1].endsWith(END)) all.push({ at: parts[i], statement: parts[i + 1].slice(0, -END.length) });

			return all;
		},
	};
}
