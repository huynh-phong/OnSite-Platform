import { Type, type TSchema } from '@sinclair/typebox';

export const bearer = [{ bearerAuth: [] }];
export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const Timestamp = Type.Unsafe<string>({ type: 'string', format: 'date-time' });

const ErrorBody = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }),
});

/** Documents the uniform error body for the given status codes. */
export function errors(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, ErrorBody]));
}

export const VersionBody = Type.Object({ version: Type.Integer({ minimum: 1 }) });
export const IdParam = Type.Object({ id: Type.String({ minLength: 1 }) });
export const UuidParam = Type.Object({ id: Type.String({ format: 'uuid' }) });

/** For POST routes whose body is optional: Fastify would otherwise validate an absent body and refuse it. */
export const emptyBodyOk = async (request: { body: unknown }): Promise<void> => {
  request.body ??= {};
};
