import { Pool } from "pg";
import { migrate } from "../../src/database/migrate";

const connectionString =
	process.env.DATABASE_URL ??
	"postgresql://localhost/healthtech_take_home_test";

describe("database migration", () => {
	const pool = new Pool({ connectionString });

	beforeEach(async () => {
		await pool.query("DROP SCHEMA public CASCADE");
		await pool.query("CREATE SCHEMA public");
		await migrate(pool);
	});

	afterAll(async () => {
		await pool.end();
	});

	it("creates the forms and jobs tables with their expected columns", async () => {
		const result = await pool.query<{
			table_name: string;
			column_name: string;
		}>(`
			SELECT table_name, column_name
			FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND table_name IN ('forms', 'jobs')
		`);

		const columns = new Set(
			result.rows.map(({ table_name, column_name }) =>
				`${table_name}.${column_name}`,
			),
		);

		expect([...columns]).toEqual(
			expect.arrayContaining([
					"forms.id",
					"forms.session_id",
					"forms.application_reference",
					"forms.raw_payload",
					"forms.transformed_payload",
					"forms.status",
					"forms.error",
					"forms.created_at",
					"forms.updated_at",
					"jobs.id",
					"jobs.form_id",
					"jobs.type",
					"jobs.status",
					"jobs.attempt_count",
					"jobs.claimed_at",
					"jobs.error",
					"jobs.created_at",
					"jobs.updated_at",
			]),
		);
	});

	it("retains raw payloads when external identifiers are absent", async () => {
		const result = await pool.query<{ raw_payload: unknown }>(
			"INSERT INTO forms (raw_payload) VALUES ($1) RETURNING raw_payload",
			[{ unexpected: "payload" }],
		);

		expect(result.rows[0].raw_payload).toEqual({ unexpected: "payload" });
	});

	it("allows a session to contain multiple applications", async () => {
		await pool.query(
			"INSERT INTO forms (session_id, application_reference, raw_payload) VALUES ($1, $2, $3)",
			["session-1", "application-1", {}],
		);

		await expect(
			pool.query(
				"INSERT INTO forms (session_id, application_reference, raw_payload) VALUES ($1, $2, $3)",
				["session-1", "application-2", {}],
			),
		).resolves.toBeDefined();
	});

	it("rejects a duplicate application reference", async () => {
		await pool.query(
			"INSERT INTO forms (application_reference, raw_payload) VALUES ($1, $2)",
			["application-1", {}],
		);

		await expect(
			pool.query(
				"INSERT INTO forms (application_reference, raw_payload) VALUES ($1, $2)",
				["application-1", {}],
			),
		).rejects.toMatchObject({ code: "23505" });
	});

	it("allows only one job of each type per form", async () => {
		const form = await pool.query<{ id: string }>(
			"INSERT INTO forms (raw_payload) VALUES ($1) RETURNING id",
			[{}],
		);
		const formId = form.rows[0].id;

		await pool.query(
			"INSERT INTO jobs (form_id, type) VALUES ($1, 'PROCESS_FORM')",
			[formId],
		);
		await pool.query(
			"INSERT INTO jobs (form_id, type) VALUES ($1, 'SEND_EMAIL')",
			[formId],
		);

		await expect(
			pool.query(
				"INSERT INTO jobs (form_id, type) VALUES ($1, 'PROCESS_FORM')",
				[formId],
			),
		).rejects.toMatchObject({ code: "23505" });
	});

	it("indexes session identifiers without making them unique", async () => {
		const result = await pool.query<{ indexdef: string }>(`
			SELECT indexdef
			FROM pg_indexes
			WHERE schemaname = 'public'
			  AND tablename = 'forms'
			  AND indexdef LIKE '%(session_id)%'
		`);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].indexdef).not.toContain("UNIQUE");
	});
});
