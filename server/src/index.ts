import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnect, prisma } from './db/prisma.js';
import { startMessageWorker, stopMessageWorker } from './modules/communication/dispatcher.js';

async function main(): Promise<void> {
  await prisma.$connect();

  const app = createApp();

  // Retries and anything the fire-and-forget nudge missed still go out.
  startMessageWorker();

  const server = app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`SMS API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n${signal} received, shutting down...`);
    stopMessageWorker();
    server.close(async () => {
      await disconnect();
      process.exit(0);
    });
    // Don't hang forever on lingering connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server', err);
  process.exit(1);
});
