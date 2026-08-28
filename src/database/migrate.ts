import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

const migrations = ["001_initial.sql"] as const;

export async function migrate(pool: Pool): Promise<void> {
	const client = await pool.connect();

	try {
		await client.query("BEGIN");
		await client.query(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				name TEXT PRIMARY KEY,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		for (const migration of migrations) {
			const applied = await client.query(
				"SELECT 1 FROM schema_migrations WHERE name = $1",
				[migration],
			);

			if (applied.rowCount) {
				continue;
			}

			const sql = await readFile(
				resolve(__dirname, "migrations", migration),
				"utf8",
			);
			await client.query(sql);
			await client.query(
				"INSERT INTO schema_migrations (name) VALUES ($1)",
				[migration],
			);
		}

		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function run(): Promise<void> {
	const connectionString = process.env.DATABASE_URL;

	if (!connectionString) {
		throw new Error("DATABASE_URL is required");
	}

	const pool = new Pool({ connectionString });

	try {
		await migrate(pool);
	} finally {
		await pool.end();
	}
}

if (require.main === module) {
	run().catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}
