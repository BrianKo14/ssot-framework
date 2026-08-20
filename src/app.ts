import { connect } from './db.js';

async function main() {

	const db = await connect(process.env.DATABASE_URL!);

	try {
		const users = await db.query('SELECT * FROM cliente');
		console.log(users);
	} finally {
		await db.close();
	}

}

main();