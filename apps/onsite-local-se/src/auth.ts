import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

export type Role = 'customer' | 'staff' | 'admin';

export interface Principal {
  sub: string;
  role: Role;
  country: string;
  store_id?: string;
  customer_id?: string;
  iat: number;
  exp: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function signature(content: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(content).digest();
}

export function signToken(claims: Omit<Principal, 'iat' | 'exp'>, secret: string, ttlSeconds: number, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const content = `${HEADER}.${base64url(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds }))}`;
  return `${content}.${base64url(signature(content, secret))}`;
}

/** Throws unless the signature, algorithm, expiry and country all hold. */
export function verifyToken(token: string, secret: string, country: string, now = Date.now()): Principal {
  const invalid = new AppError(401, 'UNAUTHORIZED', 'A valid token is required');
  const [header, payload, signed, extra] = token.split('.');
  if (!header || !payload || !signed || extra !== undefined || header !== HEADER) throw invalid;
  const expected = signature(`${header}.${payload}`, secret);
  const presented = Buffer.from(signed, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) throw invalid;
  let claims: Principal;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Principal;
  } catch {
    throw invalid;
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw invalid;
  if (claims.country !== country) throw new AppError(403, 'FORBIDDEN', 'Token belongs to another country');
  return claims;
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

export interface AuthOptions {
  jwtSecret: string;
  countryCode: string;
}

/** preHandler for a route: authenticates, then allows only the given roles. */
export function requireRole(options: AuthOptions, ...roles: Role[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (!token) throw new AppError(401, 'UNAUTHORIZED', 'A valid token is required');
    const principal = verifyToken(token, options.jwtSecret, options.countryCode);
    request.principal = principal;
    if (roles.length > 0 && !roles.includes(principal.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Your role may not do this');
    }
  };
}

export function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw new AppError(401, 'UNAUTHORIZED', 'A valid token is required');
  return request.principal;
}
