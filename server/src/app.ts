import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env, isProduction, isTest } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      credentials: true,
      exposedHeaders: ['X-Total-Count'],
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (!isTest) {
    app.use(morgan(isProduction ? 'combined' : 'dev'));
  }

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: isProduction ? 300 : 10_000,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
