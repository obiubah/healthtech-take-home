import express, { NextFunction, Request, Response } from "express";
import { FormRepository } from "./forms/form.repository";

export function createApp(forms: FormRepository) {
	const app = express();

	app.use(express.json({ strict: false }));

	app.post(
		"/ingest",
		async (req: Request, res: Response, next: NextFunction) => {
			if (!isJsonObject(req.body)) {
				res.status(400).json({
					error: "Request body must be a JSON object",
				});
				return;
			}

			try {
				const result = await forms.ingest(req.body);
				res.status(result.duplicate ? 200 : 202).json(result);
			} catch (error) {
				next(error);
			}
		},
	);

	app.use(
		(
			error: unknown,
			_request: Request,
			response: Response,
			_next: NextFunction,
		) => {
			if (isMalformedJsonError(error)) {
				response.status(400).json({ error: "Malformed JSON" });
				return;
			}

			response.status(500).json({ error: "Unable to ingest form" });
		},
	);

	return app;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMalformedJsonError(error: unknown): boolean {
	return (
		error instanceof SyntaxError &&
		"status" in error &&
		error.status === 400
	);
}
