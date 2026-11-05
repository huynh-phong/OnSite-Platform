import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Cookies ignore ports, so each dashboard needs its own name or they log each other out on one host.
const COOKIE = 'onsite_central_session';
const TTL_SECONDS = 8 * 60 * 60;

function sign(expires: number, secret: string): string {
  return createHmac('sha256', secret).update(`dashboard-session:${expires}`).digest('base64url');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The browser only ever holds this signed, HttpOnly session. It never sees a service token. */
export function startSession(reply: FastifyReply, secret: string, now = Date.now()): void {
  const expires = Math.floor(now / 1000) + TTL_SECONDS;
  reply.header(
    'set-cookie',
    `${COOKIE}=${expires}.${sign(expires, secret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_SECONDS}`,
  );
}

export function endSession(reply: FastifyReply): void {
  reply.header('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

export function hasSession(request: FastifyRequest, secret: string, now = Date.now()): boolean {
  const cookie = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  if (!cookie) return false;
  const [expires, signature] = cookie.slice(COOKIE.length + 1).split('.');
  if (!expires || !signature) return false;
  const seconds = Number(expires);
  return Number.isFinite(seconds) && seconds * 1000 > now && constantTimeEqual(signature, sign(seconds, secret));
}
