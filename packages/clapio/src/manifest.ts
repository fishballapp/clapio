/**
 * The manifest: an OpenAPI document reduced to what a CLI runs. One command per operation, each with
 * its HTTP binding, the flags it takes and standalone JSON Schemas for its body and output.
 */
import * as Result from 'effect/Result';
import {
  decode,
  deref,
  HTTP_METHODS,
  jsonSchemaAt,
  OpenApiDocumentSchema,
  type OpenApiError,
  type OpenApiOperation,
  type OpenApiParameter,
  ParameterSchema,
  PathItemSchema,
  RequestBodySchema,
  ResponseSchema,
  UnsupportedOpenApiError,
} from './openapi.ts';

export type JsonSchema = {
  readonly type?: string | ReadonlyArray<string>;
  readonly enum?: ReadonlyArray<unknown>;
  readonly const?: unknown;
  readonly anyOf?: ReadonlyArray<JsonSchema>;
  readonly oneOf?: ReadonlyArray<JsonSchema>;
  readonly allOf?: ReadonlyArray<JsonSchema>;
  readonly properties?: { readonly [name: string]: JsonSchema };
  readonly required?: ReadonlyArray<string>;
  readonly readOnly?: boolean;
  readonly description?: string;
  readonly [keyword: string]: unknown;
};

export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'patch' | 'head' | 'options' | 'trace';

/** One flag of a command, and where its value goes on the request. */
export type Parameter = {
  /** The flag, without dashes: `video-asset-id`. */
  readonly flag: string;
  readonly in: 'path' | 'query' | 'header' | 'body';
  /** The name on the wire: the path segment, query key, header or body property. */
  readonly name: string;
  /** How the flag's text becomes a value; `json` for anything that isn't a scalar. */
  readonly kind: 'string' | 'number' | 'integer' | 'boolean' | 'json';
  readonly choices?: ReadonlyArray<string>;
  /** A body property is required only when the body is; `--body` can supply it instead. */
  readonly isRequired: boolean;
  readonly description?: string;
  readonly schema: JsonSchema;
};

export type Command = {
  /** The command's words: `['publications', 'add-targets']`. */
  readonly name: ReadonlyArray<string>;
  readonly operationId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly method: HttpMethod;
  /** The path template, relative to the server: `/api/v1/brands/{brandId}/publications`. */
  readonly path: string;
  readonly parameters: ReadonlyArray<Parameter>;
  /** A JSON request body; its top-level properties are also `body` parameters. */
  readonly body?: { readonly isRequired: boolean; readonly schema: JsonSchema };
  /** The JSON schema of the success response, when there is one. */
  readonly output?: JsonSchema;
  /** A DELETE: refused without `--yes`. */
  readonly isDestructive: boolean;
  /** The header that makes this write safe to retry; a fresh key is sent when none is given. */
  readonly idempotencyHeader?: string;
};

export type Manifest = {
  readonly clapio: 1;
  /** The document's OpenAPI version (`3.1.0`), which decides how its JSON Schemas read. */
  readonly openapi: string;
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly commands: ReadonlyArray<Command>;
};

/** Flags every command takes (effect/cli's built-ins too), so no parameter may take them. */
export const RESERVED_FLAGS: ReadonlySet<string> = new Set([
  'body',
  'dry-run',
  'yes',
  'help',
  'version',
  'wizard',
  'completions',
  'log-level',
]);

/** Commands added at the top level, so no command group may take their names. */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set(['commands', 'schema']);

/** How each location serialises a parameter by default: the only style clapio sends. */
const DEFAULT_STYLES: Record<OpenApiParameter['in'], { style: string; explode: boolean }> = {
  path: { style: 'simple', explode: false },
  query: { style: 'form', explode: true },
  header: { style: 'simple', explode: false },
  cookie: { style: 'form', explode: true },
};

/** Headers OpenAPI says a parameter can't describe; the HttpClient sets them. */
const IGNORED_HEADERS: ReadonlySet<string> = new Set(['accept', 'content-type', 'authorization']);

const kebabCase = (text: string): string =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();

const isJsonMediaType = (contentType: string): boolean =>
  /^application\/(?:[\w.-]+\+)?json$/.test(contentType.split(';')[0]?.trim() ?? '');

const unsupported = (message: string) => Result.fail(new UnsupportedOpenApiError({ message }));

const literalsOf = (branch: JsonSchema): ReadonlyArray<unknown> | undefined =>
  (branch.enum ?? ('const' in branch ? [branch.const] : undefined))?.filter(
    literal => literal !== null,
  );

/** The scalar types a branch can take: its literals' types, else its declared types. */
const typesOf = (branch: JsonSchema): ReadonlyArray<string> => {
  const literals = literalsOf(branch);
  if (literals !== undefined) return literals.map(literal => typeof literal);
  return [branch.type]
    .flat()
    .filter((type): type is string => type !== undefined && type !== 'null');
};

/**
 * A flag takes a scalar when every branch, `null` aside, is that one scalar type; string literals
 * become choices when every branch is literal. A one-schema `allOf` (a `$ref` with siblings) is
 * that schema.
 */
const kindOf = (schema: JsonSchema): Pick<Parameter, 'kind' | 'choices'> => {
  const { allOf, ...rest } = schema;
  const [only, ...others] = allOf ?? [];
  if (only !== undefined && others.length === 0) return kindOf({ ...rest, ...only });
  const branches = (schema.anyOf ?? schema.oneOf ?? [schema]).filter(
    branch => branch.type !== 'null',
  );
  const types = branches.map(typesOf);
  const [type, ...otherTypes] = new Set(types.flat());
  if (type === undefined || otherTypes.length > 0 || types.some(each => each.length === 0)) {
    return { kind: 'json' };
  }
  const literals = branches.map(literalsOf);
  const choices = literals.every(each => each !== undefined)
    ? literals.flat().filter(literal => typeof literal === 'string')
    : undefined;
  switch (type) {
    case 'string':
      return { kind: 'string', ...(choices === undefined ? {} : { choices }) };
    case 'number':
    case 'integer':
    case 'boolean':
      return { kind: type };
    default:
      return { kind: 'json' };
  }
};

/** `publications.addTargets` → `publications add-targets`; without a dot, the first tag is the group. */
const commandName = (operationId: string, tags: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [group] = tags;
  const words = operationId.includes('.')
    ? operationId.split('.')
    : [...(group === undefined ? [] : [group]), operationId];
  return words.map(kebabCase);
};

/** Parameters match by location and name; a header's name in any case. */
const parameterKey = ({ name, in: location }: OpenApiParameter) =>
  `${location}:${location === 'header' ? name.toLowerCase() : name}`;

const toParameter = (
  root: unknown,
  operationId: string,
  { name, in: location, required, description, schema, style, explode }: OpenApiParameter,
): Result.Result<Parameter, OpenApiError> =>
  Result.gen(function* () {
    if (location === 'cookie') {
      return yield* unsupported(`${operationId}: cookie parameters are not supported`);
    }
    const defaults = DEFAULT_STYLES[location];
    if (
      (style ?? defaults.style) !== defaults.style ||
      (explode ?? defaults.explode) !== defaults.explode
    ) {
      return yield* unsupported(
        `${operationId}: ${name} needs a parameter style clapio doesn't send`,
      );
    }
    // A parameter's value is text on the wire, so one with no schema is a string.
    const decoded = yield* jsonSchemaAt(
      root,
      schema ?? { type: 'string' },
      `${operationId} ${name}`,
    );
    const isIdempotencyKey = location === 'header' && name.toLowerCase() === 'idempotency-key';
    const parameterDescription = description ?? decoded.description;
    return {
      flag: kebabCase(name),
      in: location,
      name,
      ...kindOf(decoded),
      // An idempotency key is always sent, so the flag is never required.
      isRequired: location === 'path' || (required === true && !isIdempotencyKey),
      ...(parameterDescription === undefined ? {} : { description: parameterDescription }),
      schema: decoded,
    };
  });

const toCommand = ({
  root,
  path,
  method,
  operation,
  pathParameters,
}: {
  readonly root: unknown;
  readonly path: string;
  readonly method: HttpMethod;
  readonly operation: OpenApiOperation;
  readonly pathParameters: OpenApiOperation['parameters'];
}): Result.Result<Command, OpenApiError> =>
  Result.gen(function* () {
    const { operationId } = operation;
    if (operationId === undefined) {
      return yield* unsupported(`${method.toUpperCase()} ${path} has no operationId`);
    }
    const resolve = (parameters: OpenApiOperation['parameters']) =>
      Result.all((parameters ?? []).map(parameter => deref(root, parameter, ParameterSchema)));
    const own = yield* resolve(operation.parameters);
    const shared = yield* resolve(pathParameters);
    // An operation's parameter overrides the path item's of the same name and location.
    const requestParameters = yield* Result.all(
      [
        ...shared.filter(
          parameter => !own.some(mine => parameterKey(mine) === parameterKey(parameter)),
        ),
        ...own,
      ]
        .filter(
          ({ in: location, name }) =>
            !(location === 'header' && IGNORED_HEADERS.has(name.toLowerCase())),
        )
        .map(parameter => toParameter(root, operationId, parameter)),
    );

    const declared = new Set(
      requestParameters.filter(({ in: location }) => location === 'path').map(({ name }) => name),
    );
    const undeclared = [...path.matchAll(/\{([^}]+)\}/g)]
      .map(([, name]) => name)
      .find(name => name !== undefined && !declared.has(name));
    if (undeclared !== undefined) {
      return yield* unsupported(
        `${operationId}: the path parameter {${undeclared}} is not declared`,
      );
    }

    const body = yield* bodyOf(root, operationId, operation.requestBody);
    // A read-only property is the server's to set, so it takes no flag.
    const bodyParameters = Object.entries(body?.schema.properties ?? {})
      .filter(([, schema]) => schema.readOnly !== true)
      .map(
        ([name, schema]): Parameter => ({
          flag: kebabCase(name),
          in: 'body',
          name,
          ...kindOf(schema),
          isRequired: body?.isRequired === true && (body.schema.required ?? []).includes(name),
          ...(schema.description === undefined ? {} : { description: schema.description }),
          schema,
        }),
      );

    const parameters = [...requestParameters, ...bodyParameters];
    const flags = parameters.map(({ flag }) => flag);
    const reserved = flags.find(flag => RESERVED_FLAGS.has(flag));
    if (reserved !== undefined) {
      return yield* unsupported(`${operationId}: --${reserved} is reserved by clapio`);
    }
    const duplicate = flags.find((flag, index) => flags.indexOf(flag) !== index);
    if (duplicate !== undefined) {
      return yield* unsupported(`${operationId}: two parameters map to --${duplicate}`);
    }

    const output = yield* outputOf(root, operationId, operation.responses);
    const idempotencyHeader = requestParameters.find(
      ({ in: location, name }) => location === 'header' && name.toLowerCase() === 'idempotency-key',
    )?.name;

    return {
      name: commandName(operationId, operation.tags ?? []),
      operationId,
      ...(operation.summary === undefined ? {} : { summary: operation.summary }),
      ...(operation.description === undefined ? {} : { description: operation.description }),
      method,
      path,
      parameters,
      ...(body === undefined ? {} : { body }),
      ...(output === undefined ? {} : { output }),
      isDestructive: method === 'delete',
      ...(idempotencyHeader === undefined ? {} : { idempotencyHeader }),
    };
  });

/** The JSON request body, if the operation takes one. */
const bodyOf = (
  root: unknown,
  operationId: string,
  requestBody: OpenApiOperation['requestBody'],
): Result.Result<Command['body'], OpenApiError> =>
  Result.gen(function* () {
    if (requestBody === undefined) return undefined;
    const { required, content } = yield* deref(root, requestBody, RequestBodySchema);
    const json = Object.entries(content).find(([contentType]) => isJsonMediaType(contentType));
    if (json === undefined) {
      return yield* unsupported(`${operationId}: only JSON request bodies are supported`);
    }
    const schema = yield* jsonSchemaAt(root, json[1].schema, `${operationId} request body`);
    return { isRequired: required === true, schema };
  });

/** The JSON schema of the first 2xx response that has one. */
const outputOf = (
  root: unknown,
  operationId: string,
  responses: OpenApiOperation['responses'],
): Result.Result<JsonSchema | undefined, OpenApiError> =>
  Result.gen(function* () {
    const successes = yield* Result.all(
      Object.entries(responses ?? {})
        .filter(([status]) => /^2(?:\d\d|XX)$/i.test(status))
        .map(([, response]) => deref(root, response, ResponseSchema)),
    );
    const json = successes
      .flatMap(({ content }) => Object.entries(content ?? {}))
      .find(([contentType]) => isJsonMediaType(contentType));
    return json === undefined
      ? undefined
      : yield* jsonSchemaAt(root, json[1].schema, `${operationId} response`);
  });

/**
 * Builds the manifest from an OpenAPI 3.x document, or fails naming what is malformed
 * (`InvalidOpenApiError`) or what a CLI can't express (`UnsupportedOpenApiError`).
 */
export const fromOpenApi = (input: unknown): Result.Result<Manifest, OpenApiError> =>
  Result.gen(function* () {
    const document = yield* decode(OpenApiDocumentSchema, input, 'document');
    const perPath = yield* Result.all(
      Object.entries(document.paths).map(([path, item]) =>
        Result.flatMap(deref(input, item, PathItemSchema), pathItem =>
          Result.all(
            HTTP_METHODS.flatMap(method => {
              const operation = pathItem[method];
              return operation === undefined
                ? []
                : [
                    toCommand({
                      root: input,
                      path,
                      method,
                      operation,
                      pathParameters: pathItem.parameters,
                    }),
                  ];
            }),
          ),
        ),
      ),
    );
    const commands = perPath.flat();

    const reserved = commands.find(
      ({ name: [first] }) => first !== undefined && RESERVED_COMMANDS.has(first),
    );
    if (reserved !== undefined) {
      return yield* unsupported(
        `${reserved.operationId}: the command name "${reserved.name[0]}" is reserved by clapio`,
      );
    }
    const names = commands.map(({ name }) => name.join(' '));
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate !== undefined) {
      return yield* unsupported(`Two operations map to the command "${duplicate}"`);
    }
    // A word that names a command can't also name a group of commands.
    const clash = names.find(name => names.some(other => other.startsWith(`${name} `)));
    if (clash !== undefined) {
      return yield* unsupported(`"${clash}" is both a command and a command group`);
    }

    const { title, version, description } = document.info;
    return {
      clapio: 1,
      openapi: document.openapi,
      title,
      version,
      ...(description === undefined ? {} : { description }),
      commands,
    };
  });
