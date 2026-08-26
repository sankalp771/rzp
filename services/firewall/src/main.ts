import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 4003);
// buildApp throws on a misconfiguration it refuses to run with.
const app = buildApp();
// 0.0.0.0 so the Compose healthcheck and sibling containers can reach it.
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
