/**
 * Service entrypoint. Provider selection is the composition root's concern; this
 * file only reads configuration and starts the HTTP listener.
 */
import { createPool } from './persistence/db/pool.ts';
import { migrate } from './persistence/db/migrate.ts';
import { buildContainer } from './composition/container.ts';
import { createApp } from './api/app.ts';
import { MockHRInterviewerProvider, initSuccess } from './llm/providers/mock/MockHRInterviewerProvider.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const serviceApiKey = process.env.SERVICE_API_KEY;
if (!serviceApiKey) throw new Error('SERVICE_API_KEY is required');

const pool = createPool(databaseUrl);
await migrate(pool, new URL('../migrations', import.meta.url).pathname);

// LLM_PROVIDER selects the adapter. Only the mock exists in this stage; a real
// adapter plugs in here with no change to interview logic.
const provider = new MockHRInterviewerProvider({ steps: [{ kind: 'respond', payload: initSuccess() }] });

const app = createApp({ container: buildContainer({ pool, provider }), serviceApiKey });
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`hr-interviewer-service listening on ${port}`));
