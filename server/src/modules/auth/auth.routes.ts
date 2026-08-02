import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { isProduction } from '../../config/env.js';
import * as authService from './auth.service.js';

export const authRouter: Router = Router();

// Brute-force protection on the credential endpoints (PRD section 6).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction ? 20 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts, try again later' } },
});

const passwordRules = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a number');

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
  schoolCode: z.string().trim().min(1).optional(),
});

authRouter.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password, schoolCode } = req.body as z.infer<typeof loginSchema>;
    const result = await authService.login(email, password, schoolCode, {
      userAgent: req.header('user-agent') ?? undefined,
      ipAddress: req.ip,
    });

    req.user = {
      id: result.user.id,
      schoolId: result.user.schoolId,
      role: result.user.role,
      email: result.user.email,
      firstName: result.user.firstName,
      lastName: result.user.lastName,
      permissions: result.user.permissions,
    };
    await audit(req, { action: 'auth.login', entityType: 'User', entityId: result.user.id });

    res.json(result);
  }),
);

authRouter.post(
  '/refresh',
  validate(z.object({ refreshToken: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const tokens = await authService.refresh(req.body.refreshToken, {
      userAgent: req.header('user-agent') ?? undefined,
      ipAddress: req.ip,
    });
    res.json(tokens);
  }),
);

authRouter.post(
  '/logout',
  authenticate,
  validate(z.object({ refreshToken: z.string().optional() })),
  asyncHandler(async (req, res) => {
    await authService.logout(req.body.refreshToken, req.user!.id);
    await audit(req, { action: 'auth.logout', entityType: 'User', entityId: req.user!.id });
    res.status(204).send();
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await authService.getProfile(req.user!.id));
  }),
);

authRouter.get(
  '/sessions',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ data: await authService.listSessions(req.user!.id) });
  }),
);

authRouter.delete(
  '/sessions/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    await authService.revokeSession(req.user!.id, req.params.id as string);
    res.status(204).send();
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  validate(z.object({ email: z.string().email(), schoolCode: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const result = await authService.requestPasswordReset(req.body.email, req.body.schoolCode);

    // TODO(delivery): hand the token to the email/SMS dispatcher once a
    // transport is configured. Until then it is surfaced in non-production so
    // the flow is testable end to end.
    res.json({
      message: 'If that account exists, password reset instructions have been sent.',
      ...(isProduction ? {} : { devToken: result.token }),
    });
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  validate(z.object({ token: z.string().min(1), password: passwordRules })),
  asyncHandler(async (req, res) => {
    await authService.resetPassword(req.body.token, req.body.password);
    res.json({ message: 'Password has been reset. Please sign in.' });
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate(z.object({ currentPassword: z.string().min(1), newPassword: passwordRules })),
  asyncHandler(async (req, res) => {
    await authService.changePassword(
      req.user!.id,
      req.body.currentPassword,
      req.body.newPassword,
    );
    await audit(req, { action: 'auth.change_password', entityType: 'User', entityId: req.user!.id });
    res.json({ message: 'Password updated' });
  }),
);
