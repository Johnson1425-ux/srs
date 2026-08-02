import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import argon2 from 'argon2';
import type { Role } from '@prisma/client';
import { env } from '../config/env.js';

export interface AccessTokenPayload {
  sub: string; // user id
  schoolId: string | null;
  role: Role;
  tokenType: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string; // session id
  tokenType: 'refresh';
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'tokenType'>): string {
  return jwt.sign({ ...payload, tokenType: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  if (decoded.tokenType !== 'access') throw new Error('Wrong token type');
  return decoded;
}

export function signRefreshToken(payload: Omit<RefreshTokenPayload, 'tokenType'>): string {
  return jwt.sign({ ...payload, tokenType: 'refresh' }, env.JWT_REFRESH_SECRET, {
    expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d`,
  } as SignOptions);
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  if (decoded.tokenType !== 'refresh') throw new Error('Wrong token type');
  return decoded;
}

/** Refresh tokens and reset tokens are stored hashed, never in the clear. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
