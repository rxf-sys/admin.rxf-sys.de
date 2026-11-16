import type { ErrorResponse } from '@rxf/contracts';
import type { FastifyError, FastifyInstance } from 'fastify';

/** An expected failure with a stable code for the UI (ADR 0002 error format). */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function envelope(code: string, message: string, details?: Record<string, unknown>): ErrorResponse {
  return { error: details ? { code, message, details } : { code, message } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send(envelope('NOT_FOUND', `${request.method} ${request.url.split('?')[0]} does not exist`));
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(envelope(error.code, error.message, error.details));
    }
    if (error.validation) {
      // Issue messages describe the expected type, never the submitted value.
      const issues = error.validation.map((issue) => ({ path: issue.instancePath, message: issue.message }));
      return reply.code(400).send(
        envelope('VALIDATION_FAILED', 'The request does not match the schema', {
          in: error.validationContext,
          issues,
        }),
      );
    }
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send(envelope(error.code ?? 'BAD_REQUEST', error.message));
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send(envelope('INTERNAL', 'Internal server error'));
  });
}
