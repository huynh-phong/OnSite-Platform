import type { FastifyError, FastifyInstance } from 'fastify';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found', request_id: request.id },
    });
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, request_id: request.id },
      });
    }
    if ('validation' in error && error.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: error.message, request_id: request.id },
      });
    }
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    return reply.code(status).send({
      error: {
        code: status >= 500 ? 'INTERNAL_ERROR' : (error.code ?? 'BAD_REQUEST'),
        message: status >= 500 ? 'Internal server error' : error.message,
        request_id: request.id,
      },
    });
  });
}
