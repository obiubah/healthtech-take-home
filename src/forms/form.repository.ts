import { Pool } from "pg";

export type FormStatus = "PENDING" | "READY" | "FAILED";

export type IngestResult = {
	id: string;
	status: FormStatus;
	duplicate: boolean;
};

type StoredForm = {
	id: string;
	status: FormStatus;
};

export class FormRepository {
	constructor(private readonly pool: Pool) {}

	async ingest(rawPayload: Record<string, unknown>): Promise<IngestResult> {
		const sessionId = readString(rawPayload, "session_id");
		const applicationReference = readString(
			rawPayload,
			"application_reference",
		);
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const inserted = applicationReference
				? await client.query<StoredForm>(
						`INSERT INTO forms (
							session_id,
							application_reference,
							raw_payload
						)
						VALUES ($1, $2, $3)
						ON CONFLICT (application_reference) DO NOTHING
						RETURNING id, status`,
						[sessionId, applicationReference, rawPayload],
					)
				: await client.query<StoredForm>(
						`INSERT INTO forms (session_id, raw_payload)
						 VALUES ($1, $2)
						 RETURNING id, status`,
						[sessionId, rawPayload],
					);

			const form = inserted.rows[0];

			if (!form && applicationReference) {
				const existing = await client.query<StoredForm>(
					"SELECT id, status FROM forms WHERE application_reference = $1",
					[applicationReference],
				);
				await client.query("COMMIT");

				return {
					...existing.rows[0],
					duplicate: true,
				};
			}

			await client.query(
				"INSERT INTO jobs (form_id, type) VALUES ($1, 'PROCESS_FORM')",
				[form.id],
			);
			await client.query("COMMIT");

			return {
				...form,
				duplicate: false,
			};
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
}

function readString(
	payload: Record<string, unknown>,
	field: string,
): string | null {
	const value = payload[field];
	return typeof value === "string" ? value : null;
}
