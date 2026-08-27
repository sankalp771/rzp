import { buildApp } from './server.js';

const port = Number(process.env['PORT'] ?? 4005);
const app = buildApp();
// 0.0.0.0 inside the container; Compose publishes the port on localhost only
// (THREAT_MODEL non-goals: the console has no login of its own).
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
