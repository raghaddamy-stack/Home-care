import { createApp } from './app.js';
import { Db } from './db.js';
import { seed } from './seed.js';

const db = new Db(process.env.DB_PATH ?? 'homecare.db');
seed(db);
const port = Number(process.env.PORT ?? 3000);
createApp(db).listen(port, () => console.log(`Home care API on http://localhost:${port}`));
