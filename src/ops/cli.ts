import { connect, type Db } from '../db/postgres.js';

/** Waits for a database to be available, retrying up to `attempts` times. */
export async function waitForDb(url: string, attempts = 20): Promise<Db> {
	for (let left = attempts; ; left--) {
		try {
			return await connect(url);
		} catch (err) {
			if (left <= 1) throw err;

			await new Promise(resolve => setTimeout(resolve, 500));
		}
	}
}

/** Runs a CLI script and handles errors. */
export function run(main: () => Promise<void>): void {
	main().catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	});
}
