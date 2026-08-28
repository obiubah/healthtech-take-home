import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../src/app";
import { migrate } from "../src/database/migrate";
import { FormRepository } from "../src/forms/form.repository";
import personOne from "../src/forms/examples/person_one.json";

const connectionString =
	process.env.TEST_DATABASE_URL ??
	"postgresql://localhost/healthtech_take_home_test";

describe("POST /ingest", () => {
	const pool = new Pool({ connectionString });
	const app = createApp(new FormRepository(pool));

	beforeAll(async () => {
		await migrate(pool);
	});

	beforeEach(async () => {
		await pool.query("DROP TRIGGER IF EXISTS reject_job_insert ON jobs");
		await pool.query("DROP FUNCTION IF EXISTS reject_job_insert");
		await pool.query("TRUNCATE jobs, forms");
	});

	afterAll(async () => {
		await pool.end();
	});

	it("durably accepts a form and queues it for processing", async () => {
		const response = await request(app).post("/ingest").send(personOne);

		expect(response.status).toBe(202);
		expect(response.body).toEqual({
			id: expect.any(String),
			status: "PENDING",
			duplicate: false,
		});

		const form = await pool.query(
			"SELECT session_id, application_reference, raw_payload, status FROM forms",
		);
		expect(form.rows).toEqual([
			{
				session_id: personOne.session_id,
				application_reference: personOne.application_reference,
				raw_payload: personOne,
				status: "PENDING",
			},
		]);

		const job = await pool.query(
			"SELECT form_id, type, status FROM jobs",
		);
		expect(job.rows).toEqual([
			{
				form_id: response.body.id,
				type: "PROCESS_FORM",
				status: "PENDING",
			},
		]);
	});

	it("returns the existing form for a duplicate application", async () => {
		const first = await request(app).post("/ingest").send(personOne);
		const duplicate = await request(app)
			.post("/ingest")
			.send({ ...personOne, session_id: "a-different-session" });

		expect(duplicate.status).toBe(200);
		expect(duplicate.body).toEqual({
			id: first.body.id,
			status: "PENDING",
			duplicate: true,
		});

		const counts = await pool.query(`
			SELECT
				(SELECT COUNT(*)::int FROM forms) AS forms,
				(SELECT COUNT(*)::int FROM jobs) AS jobs
		`);
		expect(counts.rows[0]).toEqual({ forms: 1, jobs: 1 });
	});

	it("creates one form when duplicate deliveries arrive concurrently", async () => {
		const responses = await Promise.all(
			Array.from({ length: 5 }, () =>
				request(app).post("/ingest").send(personOne),
			),
		);

		expect(responses.filter(({ status }) => status === 202)).toHaveLength(1);
		expect(responses.filter(({ status }) => status === 200)).toHaveLength(4);
		expect(new Set(responses.map(({ body }) => body.id)).size).toBe(1);

		const counts = await pool.query(`
			SELECT
				(SELECT COUNT(*)::int FROM forms) AS forms,
				(SELECT COUNT(*)::int FROM jobs) AS jobs
		`);
		expect(counts.rows[0]).toEqual({ forms: 1, jobs: 1 });
	});

	it("accepts multiple applications from one session", async () => {
		const secondApplication = {
			...personOne,
			application_reference: "GRU-999999-2026",
		};

		const first = await request(app).post("/ingest").send(personOne);
		const second = await request(app)
			.post("/ingest")
			.send(secondApplication);

		expect(first.status).toBe(202);
		expect(second.status).toBe(202);

		const count = await pool.query<{ count: number }>(
			"SELECT COUNT(*)::int AS count FROM forms WHERE session_id = $1",
			[personOne.session_id],
		);
		expect(count.rows[0].count).toBe(2);
	});

	it("retains a JSON object that does not match the provider schema", async () => {
		const rawPayload = { unexpected_field: "retained exactly" };

		const response = await request(app).post("/ingest").send(rawPayload);

		expect(response.status).toBe(202);
		const form = await pool.query(
			"SELECT session_id, application_reference, raw_payload FROM forms",
		);
		expect(form.rows).toEqual([
			{
				session_id: null,
				application_reference: null,
				raw_payload: rawPayload,
			},
		]);
	});

	it.each([[], "not an object", 42, null])(
		"rejects the non-object JSON value %p",
		async (body) => {
			const response = await request(app)
				.post("/ingest")
				.set("Content-Type", "application/json")
				.send(JSON.stringify(body));

			expect(response.status).toBe(400);
			expect(response.body).toEqual({
				error: "Request body must be a JSON object",
			});
		},
	);

	it("rejects malformed JSON", async () => {
		const response = await request(app)
			.post("/ingest")
			.set("Content-Type", "application/json")
			.send('{"broken"');

		expect(response.status).toBe(400);
	});

	it("rolls back the form when its processing job cannot be created", async () => {
		await pool.query(`
			CREATE FUNCTION reject_job_insert() RETURNS trigger AS $$
			BEGIN
				RAISE EXCEPTION 'job insert rejected for test';
			END;
			$$ LANGUAGE plpgsql
		`);
		await pool.query(`
			CREATE TRIGGER reject_job_insert
			BEFORE INSERT ON jobs
			FOR EACH ROW EXECUTE FUNCTION reject_job_insert()
		`);

		const response = await request(app).post("/ingest").send(personOne);

		expect(response.status).toBe(500);
		const count = await pool.query<{ count: number }>(
			"SELECT COUNT(*)::int AS count FROM forms",
		);
		expect(count.rows[0].count).toBe(0);
	});
});
