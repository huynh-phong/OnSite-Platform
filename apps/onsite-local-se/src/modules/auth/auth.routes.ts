import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { errors, Nullable } from '../routes-common.js';
import type { AuthService } from './auth.service.js';

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  app.post<{ Body: { username: string; password: string } }>(
    '/api/v1/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Log in with a demo account and receive a JWT valid for 8 hours',
        body: Type.Object({
          username: Type.String({ minLength: 1, maxLength: 100 }),
          password: Type.String({ minLength: 1, maxLength: 200 }),
        }),
        response: {
          200: Type.Object({
            access_token: Type.String(),
            token_type: Type.Literal('Bearer'),
            expires_in: Type.Integer(),
            user_id: Type.String(),
            role: Type.String(),
            country: Type.String(),
            store_id: Nullable(Type.String()),
            customer_id: Nullable(Type.String()),
          }),
          ...errors(400, 401),
        },
      },
    },
    async (request) => {
      const result = await auth.login(request.body.username, request.body.password);
      request.auditActor = result.user_id;
      return result;
    },
  );
}
