// The CLI that lists and clears locks.

// See src/ops/README.md for usage instructions.

import { authTables } from '../auth/entities.js';
import { loadConfig } from '../config.js';
import type { Db } from '../db/postgres.js';
import { LOCK } from '../schema/reserved.js';
import type { TableInfo } from '../schema/model.js';
import { where } from '../sql/filter.js';
import { columnList, q, tableRef } from '../sql/identifier.js';
import { run, waitForDb } from './cli.js';


const USAGE = 'usage: npm run locks [-- --release] [-- --user <u>] [-- --entity <e>]';

interface Options { release: boolean; user?: string; entity?: string }

function options(argv: string[]): Options {
	const opts: Options = { release: false };

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--release') { opts.release = true; continue; }

		const named = argv[i] === '--user' ? 'user' : argv[i] === '--entity' ? 'entity' : null;

		if (named === null) throw new Error(`unknown option ${argv[i]}\n${USAGE}`);

		const value = argv[++i];

		if (value === undefined) throw new Error(`${argv[i - 1]} needs a value\n${USAGE}`);

		opts[named] = value;
	}

	return opts;
}

/** Application's tables + the framework's own. */
const allTables = (tables: TableInfo[]): TableInfo[] => [...authTables, ...tables];

/** The tables this run is about. */
function asked(tables: TableInfo[], entity?: string): TableInfo[] {
	if (entity === undefined) return tables;

	const one = tables.find(t => t.entity === entity);

	if (!one) throw new Error(`no entity named "${entity}"`);

	return [one];
}

/** A claim (locked record), addressed the way `auth.presence` and the poll address a record (pk values joined). */
interface Claim { entity: string; record: string; holder: string }

async function claims(db: Db, tables: TableInfo[], user?: string): Promise<Claim[]> {
	const found: Claim[] = [];

	for (const t of tables) {
		const params: unknown[] = [];
		const conds = [
			`${q(LOCK.name)} is not null`,
			...(user === undefined ? [] : [`${q(LOCK.name)} = $${params.push(user)}`]),
		];

		const rows = await db.query(
			`select ${columnList(t.pk)}, ${q(LOCK.name)} from ${tableRef(t)}${where(conds)}`
			+ ` order by ${columnList(t.pk)}`, params);

		for (const row of rows)
			found.push({
				entity: t.entity,
				record: t.pk.map(c => String(row[c.name])).join('/'),
				holder: String(row[LOCK.name]),
			});
	}

	return found;
}

async function release(db: Db, tables: TableInfo[], user?: string): Promise<number> {
	let freed = 0;

	for (const t of tables) {
		const params: unknown[] = [];
		const conds = [
			`${q(LOCK.name)} is not null`,
			...(user === undefined ? [] : [`${q(LOCK.name)} = $${params.push(user)}`]),
		];

		const rows = await db.query(
			`update ${tableRef(t)} set ${q(LOCK.name)} = null${where(conds)}`
			+ ` returning ${columnList(t.pk)}`, params);

		freed += rows.length;
	}

	return freed;
}

export function locksCli(tables: TableInfo[]): void {
	run(async () => {
		const opts = options(process.argv.slice(2));

		if (opts.release && opts.user === undefined && opts.entity === undefined)
			throw new Error(`--release needs --user or --entity: it will not clear every claim at once\n${USAGE}`);

		const chosen = asked(allTables(tables), opts.entity);
		const db = await waitForDb(loadConfig().databaseUrl);

		try {
			if (!opts.release) {
				const held = await claims(db, chosen, opts.user);

				for (const c of held) console.log(`${c.entity}\t${c.record}\t${c.holder}`);

				console.log(held.length === 1 ? '1 claim' : `${held.length} claims`);

				return;
			}

			const freed = await release(db, chosen, opts.user);

			console.log(freed === 1 ? '1 claim released' : `${freed} claims released`);
		} finally {
			await db.close();
		}
	});
}
