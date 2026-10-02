/**
 * Reading an OpenAPI 3.x document: the part of it the manifest reads, as schemas, and its `$ref`s,
 * resolved or inlined. Everything here is decoded, so a malformed document is an error, not a cast.
 */

import * as Data from 'effect/Data';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { isRecord } from './json.ts';
import type { HttpMethod, JsonSchema } from './manifest.ts';

/** The document isn't the OpenAPI it claims to be: a field has the wrong shape, a `$ref` dangles. */
export class InvalidOpenApiError extends Data.TaggedError('InvalidOpenApiError')<{
  readonly message: string;
}> {}

/** Valid OpenAPI that a CLI can't express (a cookie parameter, a recursive schema, …). */
export class UnsupportedOpenApiError extends Data.TaggedError('UnsupportedOpenApiError')<{
  readonly message: string;
}> {}

export type OpenApiError = InvalidOpenApiError | UnsupportedOpenApiError;

const ReferenceSchema = Schema.Struct({ $ref: Schema.String });
type Reference = typeof ReferenceSchema.Type;

/** `schema` itself, or a `$ref` to one. */
const OrReference = <S extends Schema.Top>(schema: S) => Schema.Union([ReferenceSchema, schema]);

/** The JSON Schema keywords the manifest reads, decoded; every other keyword passes through. */
export const JsonSchemaSchema: Schema.Codec<JsonSchema> = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    enum: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    const: Schema.optionalKey(Schema.Unknown),
    anyOf: Schema.optionalKey(Schema.Array(Schema.suspend(() => JsonSchemaSchema))),
    oneOf: Schema.optionalKey(Schema.Array(Schema.suspend(() => JsonSchemaSchema))),
    allOf: Schema.optionalKey(Schema.Array(Schema.suspend(() => JsonSchemaSchema))),
    properties: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.suspend(() => JsonSchemaSchema),
      ),
    ),
    required: Schema.optionalKey(Schema.Array(Schema.String)),
    readOnly: Schema.optionalKey(Schema.Boolean),
    description: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

// A schema inside the document stays raw (`Unknown`) until its `$ref`s are inlined.
export const ParameterSchema = Schema.Struct({
  name: Schema.String,
  in: Schema.Literals(['path', 'query', 'header', 'cookie']),
  required: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  schema: Schema.optionalKey(Schema.Unknown),
  style: Schema.optionalKey(Schema.String),
  explode: Schema.optionalKey(Schema.Boolean),
});
export type OpenApiParameter = typeof ParameterSchema.Type;

const MediaTypesSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ schema: Schema.optionalKey(Schema.Unknown) }),
);

export const RequestBodySchema = Schema.Struct({
  required: Schema.optionalKey(Schema.Boolean),
  content: MediaTypesSchema,
});

export const ResponseSchema = Schema.Struct({ content: Schema.optionalKey(MediaTypesSchema) });

const ParametersSchema = Schema.Array(OrReference(ParameterSchema));

const OperationSchema = Schema.Struct({
  operationId: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  parameters: Schema.optionalKey(ParametersSchema),
  requestBody: Schema.optionalKey(OrReference(RequestBodySchema)),
  responses: Schema.optionalKey(Schema.Record(Schema.String, OrReference(ResponseSchema))),
});
export type OpenApiOperation = typeof OperationSchema.Type;

export const PathItemSchema = Schema.Struct({
  parameters: Schema.optionalKey(ParametersSchema),
  get: Schema.optionalKey(OperationSchema),
  put: Schema.optionalKey(OperationSchema),
  post: Schema.optionalKey(OperationSchema),
  delete: Schema.optionalKey(OperationSchema),
  patch: Schema.optionalKey(OperationSchema),
  head: Schema.optionalKey(OperationSchema),
  options: Schema.optionalKey(OperationSchema),
  trace: Schema.optionalKey(OperationSchema),
});

export const OpenApiDocumentSchema = Schema.Struct({
  openapi: Schema.String,
  info: Schema.Struct({
    title: Schema.String,
    version: Schema.String,
    description: Schema.optionalKey(Schema.String),
  }),
  paths: Schema.Record(Schema.String, OrReference(PathItemSchema)),
});

export const HTTP_METHODS: ReadonlyArray<HttpMethod> = [
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'head',
  'options',
  'trace',
];

/** `input` decoded by `schema`; a mismatch names where it was found. */
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  where: string,
): Result.Result<S['Type'], InvalidOpenApiError> =>
  Result.mapError(
    Schema.decodeUnknownResult(schema)(input),
    error => new InvalidOpenApiError({ message: `${where}: ${error.message}` }),
  );

const isReference = (value: unknown): value is Reference =>
  isRecord(value) && typeof value.$ref === 'string';

/** What a local `$ref` (`#/components/schemas/Brand`) points at in the raw document. */
const resolvePointer = (root: unknown, ref: string): Result.Result<unknown, OpenApiError> => {
  if (!ref.startsWith('#/')) {
    return Result.fail(
      new UnsupportedOpenApiError({ message: `Only local $refs are supported: ${ref}` }),
    );
  }
  const tokens = ref
    .slice(2)
    .split('/')
    .map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  const target = tokens.reduce<unknown>(
    (node, token) => (isRecord(node) && Object.hasOwn(node, token) ? node[token] : undefined),
    root,
  );
  return target === undefined
    ? Result.fail(new InvalidOpenApiError({ message: `Unresolvable $ref: ${ref}` }))
    : Result.succeed(target);
};

/** The object itself, or the one its `$ref` points at, decoded by `schema`. */
export const deref = <S extends Schema.ConstraintDecoder<unknown>>(
  root: unknown,
  value: S['Type'] | Reference,
  schema: S,
): Result.Result<S['Type'], OpenApiError> =>
  isReference(value)
    ? Result.flatMap(resolvePointer(root, value.$ref), target =>
        isReference(target) ? deref(root, target, schema) : decode(schema, target, value.$ref),
      )
    : Result.succeed(value);

/** The raw value with every `$ref` inlined, so a schema stands alone. A recursive one has no inline form. */
const inlineRefs = (
  root: unknown,
  value: unknown,
  visiting: ReadonlySet<string>,
): Result.Result<unknown, OpenApiError> => {
  if (Array.isArray(value)) return Result.all(value.map(item => inlineRefs(root, item, visiting)));
  if (!isRecord(value)) return Result.succeed(value);
  if (!isReference(value)) {
    return Result.all(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, inlineRefs(root, item, visiting)]),
      ),
    );
  }
  const { $ref, ...siblings } = value;
  if (visiting.has($ref)) {
    return Result.fail(
      new UnsupportedOpenApiError({ message: `Recursive schemas are not supported: ${$ref}` }),
    );
  }
  return Result.gen(function* () {
    const target = yield* inlineRefs(
      root,
      yield* resolvePointer(root, $ref),
      new Set([...visiting, $ref]),
    );
    const rest = yield* inlineRefs(root, siblings, visiting);
    return { ...(isRecord(target) ? target : {}), ...(isRecord(rest) ? rest : {}) };
  });
};

/** A raw schema from the document, `$ref`s inlined and decoded; no schema is the empty one. */
export const jsonSchemaAt = (
  root: unknown,
  schema: unknown,
  where: string,
): Result.Result<JsonSchema, OpenApiError> =>
  Result.flatMap(inlineRefs(root, schema ?? {}, new Set()), inlined =>
    decode(JsonSchemaSchema, inlined, where),
  );
