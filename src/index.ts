import { createApp } from "./app";
import { createPool } from "./database/pool";
import { FormRepository } from "./forms/form.repository";

const PORT = process.env.PORT || 3000;
const pool = createPool();
const app = createApp(new FormRepository(pool));

app.listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`);
});
