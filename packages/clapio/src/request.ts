import * as Data from 'effect/Data';
import * as Result from 'effect/Result';
import { isRecord, parseJson } from './json.ts';
import type { Command, HttpMethod, Parameter } from './manifest.ts';

/** The invocation is wrong (a missing flag, a bad value), so nothing was sent. */
export class UsageError extends Data.TaggedError('UsageError')<{ readonly message: string }> {}

/**
 * What was typed: each given flag's text (a bare boolean flag's `true`) and `--body`'s JSON text.
 * `values` come from code (a wrap's `send`), already values, and win over everything typed.
 * `defaults` is the lowest precedence: a default fills a flag only when neither the flag nor
 * `--body` gives that value.
 */
export type Invocation = {
  readonly flags: { readonly [flag: string]: string | boolean | undefined };
  readonly body?: string;
  readonly values?: { readonly [flag: string]: unknown };
  readonly defaults?: { readonly [flag: string]: string | undefined };
};

/** The request a command sends; `url` is relative to the server (path and query). */
export type HttpRequest = {
  readonly method: Uppercase<HttpMethod>;
  readonly url: string;
  readonly headers: { readonly [name: string]: string };
  readonly body?: string;
};

const WIRE_METHODS: Record<HttpMethod, Uppercase<HttpMethod>> = {
  get: 'GET',
  put: 'PUT',
  post: 'POST',
  delete: 'DELETE',
  patch: 'PATCH',
  head: 'HEAD',
  options: 'OPTIONS',
  trace: 'TRACE',
};

const fail = (message: string) => Result.fail(new UsageError({ message }));

// `undefined` is no JSON value, so it marks text that didn't parse.
const jsonValue = (text: string, what: string): Result.Result<unknown, UsageError> => {
  const value = parseJson(text);
  return value === undefined ? fail(`${what} is not valid JSON`) : Result.succeed(value);
};

/** A flag's text as the value its schema takes. The server validates the rest. */
const parseValue = (
  { flag, kind, choices }: Parameter,
  raw: string | boolean,
): Result.Result<unknown, UsageError> => {
  if (typeof raw === 'boolean')
    return kind === 'boolean' ? Result.succeed(raw) : fail(`--${flag} needs a value`);
  switch (kind) {
    case 'string':
      return choices === undefined || choices.includes(raw)
        ? Result.succeed(raw)
        : fail(`--${flag} must be one of: ${choices.join(', ')}`);
    case 'integer':
    case 'number': {
      const number = Number(raw);
      const isValid =
        raw.trim() !== '' &&
        (kind === 'integer' ? Number.isInteger(number) : Number.isFinite(number));
      return isValid
        ? Result.succeed(number)
        : fail(`--${flag} must be ${kind === 'integer' ? 'an integer' : 'a number'}`);
    }
    case 'boolean':
      return raw === 'true' || raw === 'false'
        ? Result.succeed(raw === 'true')
        : fail(`--${flag} must be true or false`);
    case 'json':
      return jsonValue(raw, `--${flag}`);
  }
};

const queryText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

/**
 * The request an invocation of `command` sends, or what is wrong with it. Field flags are merged
 * over `--body`; a write that takes an idempotency key gets a fresh one unless given.
 */
export const buildRequest = (
  command: Command,
  { flags, body, values: fromCode = {}, defaults = {} }: Invocation,
  {
    newIdempotencyKey = () => crypto.randomUUID(),
  }: { readonly newIdempotencyKey?: () => string } = {},
): Result.Result<HttpRequest, UsageError> =>
  Result.gen(function* () {
    if (body !== undefined && command.body === undefined) {
      return yield* fail(`${command.name.join(' ')} takes no --body`);
    }
    const bodyJson = body === undefined ? undefined : yield* jsonValue(body, '--body');

    const isInBody = ({ in: location, name }: Parameter) =>
      location === 'body' && isRecord(bodyJson) && Object.hasOwn(bodyJson, name);
    const values = new Map(
      yield* Result.all(
        command.parameters.flatMap(parameter => {
          const coded = fromCode[parameter.flag];
          if (coded !== undefined) return [Result.succeed([parameter, coded] as const)];
          const raw =
            flags[parameter.flag] ?? (isInBody(parameter) ? undefined : defaults[parameter.flag]);
          return raw === undefined
            ? []
            : [Result.map(parseValue(parameter, raw), value => [parameter, value] as const)];
        }),
      ),
    );

    const bodyFields = [...values].filter(([{ in: location }]) => location === 'body');
    if (bodyFields.length > 0 && bodyJson !== undefined && !isRecord(bodyJson)) {
      return yield* fail('--body must be a JSON object to combine with field flags');
    }
    const missing = command.parameters.filter(
      parameter => parameter.isRequired && !values.has(parameter) && !isInBody(parameter),
    );
    if (missing.length > 0) {
      return yield* fail(`Missing required ${missing.map(({ flag }) => `--${flag}`).join(', ')}`);
    }

    const valuesIn = (location: Parameter['in']) =>
      [...values].filter(([parameter]) => parameter.in === location);
    const pathValues = new Map(valuesIn('path').map(([{ name }, value]) => [name, value]));
    const path = command.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
      encodeURIComponent(queryText(pathValues.get(name))),
    );
    const query = new URLSearchParams(
      valuesIn('query').flatMap(([{ name }, value]) =>
        (Array.isArray(value) ? value : [value]).map(item => [name, queryText(item)]),
      ),
    ).toString();

    const requestBody =
      bodyFields.length > 0
        ? {
            ...(isRecord(bodyJson) ? bodyJson : {}),
            ...Object.fromEntries(bodyFields.map(([{ name }, value]) => [name, value])),
          }
        : (bodyJson ?? (command.body?.isRequired ? {} : undefined));

    const headers = Object.fromEntries(
      valuesIn('header').map(([{ name }, value]) => [name, queryText(value)]),
    );
    const { idempotencyHeader } = command;
    const needsIdempotencyKey =
      idempotencyHeader !== undefined && !Object.hasOwn(headers, idempotencyHeader);
    return {
      method: WIRE_METHODS[command.method],
      url: query === '' ? path : `${path}?${query}`,
      headers: {
        ...(needsIdempotencyKey ? { [idempotencyHeader]: newIdempotencyKey() } : {}),
        ...headers,
        ...(requestBody === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
    };
  });
