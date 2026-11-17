// Playwright starts webServer before globalSetup, so the throwaway database is created here,
// then the real built API (serving the built dashboard) is started in this same process.
import pg from 'pg';

const url = process.env.DATABASE_URL;
const db = new URL(url).pathname.slice(1);
if (!db.endsWith('_e2e')) throw new Error('E2E database name must end in _e2e');
const root = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, '/postgres') });
await root.connect();
await root.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
await root.query(`CREATE DATABASE ${db}`);
await root.end();

await import('../apps/api/dist/main.js');
