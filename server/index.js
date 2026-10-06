// Local development server. On Vercel, api/index.js serves the API and
// the public/ folder is served as static files.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { app } from './app.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const server = express();
server.use(app);
server.use(express.static(publicDir));

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`KIS Social running at http://localhost:${port}`));
