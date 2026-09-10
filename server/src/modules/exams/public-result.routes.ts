import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { asyncHandler } from '../../lib/http.js';
import { resultForToken } from './result-link.service.js';

/**
 * The one route in the API that answers without a token from us.
 *
 * A parent reaches it from a link in a text message, so there is no session to
 * authenticate; the address itself is the credential. That makes it the only
 * endpoint an unauthenticated stranger can reach, and it is treated
 * accordingly — narrow, rate limited, and telling nobody anything they did not
 * already have the link for.
 */
export const publicResultRouter: Router = Router();

/**
 * Tight enough that working through the token space is hopeless, loose enough
 * that a family opening the link a few times, or a household behind one mobile
 * NAT address, is never turned away.
 */
const lookupLimiter = rateLimit({
  windowMs: 60_000,
  limit: isTest ? 10_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again shortly.' } },
});

publicResultRouter.get(
  '/:token',
  lookupLimiter,
  asyncHandler(async (req, res) => {
    const token = req.params.token as string;
    const result = await resultForToken(token);

    // A child's marks have no business in a search index, and the link is
    // pasted into messaging apps that follow what they are sent.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    res.json(result);
  }),
);
