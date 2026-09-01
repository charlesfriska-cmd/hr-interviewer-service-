/**
 * Service entrypoint. Provider selection is the composition root's concern; this
 * file only reads configuration and starts the HTTP listener.
 */
import { createPool } from './persistence/db/pool.ts';
import { migrate } from './persistence/db/migrate.ts';
import { buildContainer, buildProvider } from './composition/container.ts';
import { createApp } from './api/app.ts';
import { resolveProviderConfig } from './config/provider.config.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const serviceApiKey = process.env.SERVICE_API_KEY;
if (!serviceApiKey) throw new Error('SERVICE_API_KEY is required');

const pool = createPool(databaseUrl);
await migrate(pool, new URL('../migrations', import.meta.url).pathname);

// LLM_PROVIDER selects the adapter. Selecting `claude` without credentials fails
// here, at startup, rather than at the first candidate turn.
const providerConfig = resolveProviderConfig();
const provider = buildProvider(providerConfig);

const app = createApp({ container: buildContainer({ pool, provider }), serviceApiKey });
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () =>
  process.stdout.write(
    `${JSON.stringify({ event: 'service.started', port, provider: providerConfig.provider, model: providerConfig.model })}\n`,
  ),
);
