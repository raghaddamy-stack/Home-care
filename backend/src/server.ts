import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { Db } from './db.js';
import { seed } from './seed.js';

const db = new Db(process.env.DB_PATH ?? 'homecare.db');
seed(db);
const app = createApp(db);

// Serve the built web console (web/dist) when it exists, so one process runs everything.
const web = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(web)) {
  app.use(express.static(web));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(`${web}/index.html`));
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Home care API on http://localhost:${port}`));
