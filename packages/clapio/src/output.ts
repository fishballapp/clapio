import { isRecord, parseJson } from './json.ts';
import type { Command, Manifest } from './manifest.ts';
import type { HttpRequest } from './request.ts';

// Everything a command prints, as data: a success's JSON on stdout, a failure as one JSON line on
// stderr, `{ "error": Failure }`.

/** Why a command failed; an agent matches on `code`. */
export type Failure = {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  /** The key the write carried: retrying with `--idempotency-key <key>` replays it, never repeats it. */
  readonly idempotencyKey?: string;
  readonly [field: string]: unknown;
};

const idempotencyKeyOf = (command: Command, request: HttpRequest) => {
  const key =
    command.idempotencyHeader === undefined
      ? undefined
      : request.headers[command.idempotencyHeader];
  return key === undefined ? {} : { idempotencyKey: key };
};

export const usageFailure = (message: string): Failure => ({ code: 'UsageError', message });

/** A non-2xx response: the API's own error fields when its body is a JSON object, else its text. */
export const responseFailure = ({
  command,
  request,
  status,
  text,
}: {
  readonly command: Command;
  readonly request: HttpRequest;
  readonly status: number;
  readonly text: string;
}): Failure => {
  const body = parseJson(text);
  const fields = isRecord(body) ? body : {};
  // The API's own fields pass through, but `code` and `message` are clapio's contract: strings.
  return {
    ...fields,
    code: typeof fields.code === 'string' ? fields.code : 'HttpError',
    message:
      typeof fields.message === 'string' ? fields.message : text === '' ? `HTTP ${status}` : text,
    status,
    ...idempotencyKeyOf(command, request),
  };
};

/** No response came back, so a write may or may not have landed. */
export const networkFailure = ({
  command,
  request,
  message,
}: {
  readonly command: Command;
  readonly request: HttpRequest;
  readonly message: string;
}): Failure => ({ code: 'NetworkError', message, ...idempotencyKeyOf(command, request) });

/**
 * A 2xx whose body isn't what the spec describes. The request landed, so the failure carries the
 * key a retry must reuse.
 */
export const unexpectedResponseFailure = ({
  command,
  request,
  status,
  message,
}: {
  readonly command: Command;
  readonly request: HttpRequest;
  readonly status: number;
  readonly message: string;
}): Failure => ({
  code: 'UnexpectedResponse',
  message: `${command.name.join(' ')} was sent, but its response isn't what the spec describes: ${message}`,
  status,
  ...idempotencyKeyOf(command, request),
});

/** A success's body for stdout: JSON pretty-printed, other text as-is, nothing for an empty body. */
export const successOutput = (text: string): string | undefined => {
  if (text === '') return undefined;
  const body = parseJson(text);
  return body === undefined ? text : JSON.stringify(body, null, 2);
};

/** What `--dry-run` prints instead of sending: the request, its body parsed back for reading. */
export const dryRunOutput = ({ body, ...request }: HttpRequest): string =>
  JSON.stringify(
    { dryRun: { ...request, ...(body === undefined ? {} : { body: parseJson(body) }) } },
    null,
    2,
  );

/** A command as `commands` lists it. */
export type Listing = { readonly command: string; readonly summary?: string };

/** What `commands` prints: every generated command with its summary, then the hand-written ones. */
export const commandsOutput = (manifest: Manifest, handWritten: ReadonlyArray<Listing>): string =>
  JSON.stringify(
    [
      ...manifest.commands.map(({ name, summary }) => ({
        command: name.join(' '),
        ...(summary === undefined ? {} : { summary }),
      })),
      ...handWritten,
    ],
    null,
    2,
  );

/** The command named by its words (`publications create`) or its operationId. */
export const findCommand = (
  manifest: Manifest,
  words: ReadonlyArray<string>,
): Command | undefined => {
  const wanted = words.join(' ');
  return manifest.commands.find(
    ({ name, operationId }) => name.join(' ') === wanted || operationId === wanted,
  );
};

/** What `schema <command>` prints: the command's manifest entry, flags and JSON Schemas included. */
export const schemaOutput = (command: Command): string => JSON.stringify(command, null, 2);
