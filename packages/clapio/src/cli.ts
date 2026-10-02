import * as Arr from 'effect/Array';
import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as CliError from 'effect/cli/CliError';
import type * as CliOutput from 'effect/cli/CliOutput';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Stdio from 'effect/Stdio';
import * as Stream from 'effect/Stream';
import { parseJson } from './json.ts';
import {
  type Command as ClapioCommand,
  fromOpenApi,
  type Manifest,
  type Parameter,
} from './manifest.ts';
import {
  commandsOutput,
  dryRunOutput,
  type Failure,
  findCommand,
  type Listing,
  networkFailure,
  responseFailure,
  schemaOutput,
  successOutput,
  unexpectedResponseFailure,
  usageFailure,
} from './output.ts';
import { buildRequest, type HttpRequest } from './request.ts';

/**
 * What `clapio generate` writes: the OpenAPI document, and each operation's input (a value per
 * flag) and output as Schemas, keyed by operationId.
 */
export type Spec = {
  readonly document: unknown;
  readonly operations: {
    readonly [operationId: string]: {
      readonly input: Schema.Top;
      readonly output: Schema.Decoder<unknown>;
    };
  };
};

/**
 * Fails the command with one JSON line on stderr, `{ "error": failure }`, and exit 1. Hand-written
 * commands fail with it too, so an agent reads every failure the same way.
 */
export const fail = (failure: Failure) =>
  Effect.fail(
    new CliError.UserError({ cause: failure, userMessage: JSON.stringify({ error: failure }) }),
  );

/**
 * `formatter` with every error as one JSON line: a command's failure as it is, and effect/cli's own
 * parse errors (an unknown flag, a missing subcommand) as `UsageError`s. Help is still text on
 * stdout. Install it with `CliOutput.layer(Clapio.withJsonErrors(CliOutput.defaultFormatter()))`.
 */
export const withJsonErrors = (formatter: CliOutput.Formatter): CliOutput.Formatter => ({
  ...formatter,
  formatError: error =>
    error._tag === 'UserError'
      ? error.message
      : JSON.stringify({ error: usageFailure(error.message) }),
  formatErrors: errors =>
    errors.map(error => JSON.stringify({ error: usageFailure(error.message) })).join('\n'),
});

/** The flag's help: its description, then what it takes; "Required" unless something fills it. */
const flagDescription = (
  { description, choices, kind, isRequired }: Parameter,
  isFilled: boolean,
): string =>
  [
    description?.replace(/\.$/, ''),
    choices === undefined ? undefined : `One of: ${choices.join(', ')}`,
    kind === 'json' ? 'A JSON value' : undefined,
    isRequired && !isFilled ? 'Required' : undefined,
  ]
    .filter(part => part !== undefined)
    .join('. ');

// Every flag is optional to effect/cli: `buildRequest` checks what is required after merging
// `--body`, so `--body` can supply a required field.
const flagFor = (parameter: Parameter, isFilled: boolean) => {
  const described = <A>(flag: Flag.Flag<A>) =>
    flag.pipe(Flag.withDescription(flagDescription(parameter, isFilled)), Flag.optional);
  return parameter.kind === 'boolean'
    ? described(Flag.Boolean(parameter.flag))
    : described(Flag.String(parameter.flag));
};

/** A flag every command carries, shown only where it does something. */
const sometimesFlag = <A>(flag: Flag.Flag<A>, isShown: boolean) =>
  isShown ? flag : Flag.withHidden(flag);

/** A generated command's flags: one per parameter, and `--body`, `--dry-run` and `--yes`. */
const generatedConfig = (
  { parameters, body, isDestructive }: ClapioCommand,
  filled: ReadonlySet<string>,
) => ({
  flags: Object.fromEntries(
    parameters.map(parameter => [parameter.flag, flagFor(parameter, filled.has(parameter.flag))]),
  ),
  body: sometimesFlag(
    Flag.String('body').pipe(
      Flag.withDescription(
        'The JSON request body (field flags override it); `@file` reads a file, `-` stdin',
      ),
      Flag.optional,
    ),
    body !== undefined,
  ),
  isDryRun: Flag.Boolean('dry-run').pipe(
    Flag.withDescription('Print the request instead of sending it'),
    Flag.withDefault(false),
  ),
  isConfirmed: sometimesFlag(
    Flag.Boolean('yes').pipe(
      Flag.withDescription('Confirm this destructive command'),
      Flag.withDefault(false),
    ),
    isDestructive,
  ),
});
type GeneratedConfig = ReturnType<typeof generatedConfig>;
type GeneratedInput = Command.Command.Config.Infer<GeneratedConfig>;

/** `--body`'s text: `-` reads stdin, `@path` reads the file, anything else is the JSON itself. */
const readBody = Effect.fnUntraced(function* (value: string) {
  if (value === '-') {
    const stdio = yield* Stdio.Stdio;
    return yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
  }
  if (!value.startsWith('@')) return value;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(value.slice(1));
});

/** Sends the request: the 2xx response, else the failure line. */
const execute = Effect.fnUntraced(function* (command: ClapioCommand, request: HttpRequest) {
  const client = yield* HttpClient.HttpClient;
  const base = HttpClientRequest.make(request.method)(request.url).pipe(
    HttpClientRequest.setHeaders(request.headers),
  );
  const outcome = yield* client
    .execute(
      request.body === undefined
        ? base
        : HttpClientRequest.bodyText(base, request.body, 'application/json'),
    )
    .pipe(
      Effect.flatMap(response =>
        Effect.map(response.text, text => ({ status: response.status, text })),
      ),
      Effect.catchTag('HttpClientError', error =>
        fail(networkFailure({ command, request, message: error.message })),
      ),
    );
  if (outcome.status < 200 || outcome.status >= 300) {
    return yield* fail(responseFailure({ command, request, ...outcome }));
  }
  return { ...outcome, request } satisfies Sent;
});

/** A request that got a 2xx, and the response. */
type Sent = { readonly request: HttpRequest; readonly status: number; readonly text: string };

/** A flag's value when it isn't given, keyed by flag: `{ 'brand-id': storedBrandId }`. */
export type Defaults<E, R> = {
  readonly [flag: string]: Effect.Effect<Option.Option<string>, E, R>;
};

/** A generated command with what was typed read in, ready to send. */
type Prepared = {
  readonly command: ClapioCommand;
  readonly isDryRun: boolean;
  /**
   * Builds the request, `values` over what was typed, and sends it: the response, or `None` under
   * `--dry-run`, which printed the request instead. Every send of one run carries the same
   * idempotency key, so a retry replays the write.
   */
  readonly send: (values?: {
    readonly [flag: string]: unknown;
  }) => Effect.Effect<Option.Option<Sent>, CliError.UserError, HttpClient.HttpClient>;
};

/**
 * Reads what was typed: the flags given, the defaults for those that weren't, and `--body`. A
 * destructive command without `--yes` stops here, before a wrap's code runs.
 */
const prepare = <E, R>(
  command: ClapioCommand,
  defaults: ReadonlyArray<[string, Defaults<E, R>[string]]>,
) =>
  Effect.fnUntraced(function* ({ flags, body: bodyFlag, isDryRun, isConfirmed }: GeneratedInput) {
    if (command.isDestructive && !isConfirmed && !isDryRun) {
      return yield* fail(
        usageFailure(`${command.name.join(' ')} is destructive: pass --yes to run it`),
      );
    }
    const given = Object.fromEntries(
      Object.entries(flags).flatMap(([flag, value]: [string, Option.Option<string | boolean>]) =>
        Option.isSome(value) ? [[flag, value.value]] : [],
      ),
    );
    const defaulted = yield* Effect.forEach(
      defaults.filter(([flag]) => !Object.hasOwn(given, flag)),
      ([flag, value]) =>
        Effect.map(
          value,
          Option.map(text => [flag, text] as const),
        ),
      { concurrency: 1 },
    );
    const body = Option.isSome(bodyFlag)
      ? yield* readBody(bodyFlag.value).pipe(
          Effect.catchTag('PlatformError', error =>
            fail(usageFailure(`--body could not be read: ${error.message}`)),
          ),
        )
      : undefined;
    const idempotencyKey = crypto.randomUUID();
    const send: Prepared['send'] = Effect.fnUntraced(function* (values = {}) {
      const request = buildRequest(
        command,
        {
          flags: given,
          values,
          defaults: Object.fromEntries(Arr.getSomes(defaulted)),
          ...(body === undefined ? {} : { body }),
        },
        { newIdempotencyKey: () => idempotencyKey },
      );
      if (Result.isFailure(request)) return yield* fail(usageFailure(request.failure.message));
      if (isDryRun) {
        yield* Console.log(dryRunOutput(request.success));
        return Option.none();
      }
      return Option.some(yield* execute(command, request.success));
    });
    return { command, isDryRun, send } satisfies Prepared;
  });

/**
 * Ends a wrapped command once `send` has printed its `--dry-run` request. It is a defect, so a typed
 * `catch` in `run` passes it on; one that catches causes (`Effect.exit`, `catchCause`) can stop it,
 * so the command never prints `run`'s value after a dry run either.
 */
class DryRunEnded {}

/** A generated command with your code around its request; `wrap` builds one. */
export type Wrap<R = never> = {
  readonly spec: Spec;
  readonly operationId: string;
  readonly fills: ReadonlyArray<string>;
  /** The command, built where the wrap's own flags still have their types. */
  readonly make: <PE, PR>(
    name: string,
    generated: GeneratedConfig,
    prepare: (input: GeneratedInput) => Effect.Effect<Prepared, PE, PR>,
  ) => Command.Command<
    string,
    never,
    unknown,
    PE | CliError.UserError,
    R | PR | HttpClient.HttpClient
  >;
};

/**
 * A generated command with your code around its request, typed by the spec: pass it to `commands`
 * in `wrap`. `run` gets your own `flags`, parsed, and `send`, which sends the generated request with
 * your values over what was typed (and `--body`, and the defaults) and returns the decoded response;
 * every `send` of one run carries the same idempotency key. What `run` returns is printed as JSON,
 * and it fails only through `fail`, so every failure is the JSON line. Under `--dry-run`, `send`
 * prints the request and ends the command; `isDryRun` lets `run` skip its own side effects before.
 * `fills` names the generated flags your code supplies, so help stops calling them required. Your
 * flags can't reuse a generated flag's name, nor `--body`, `--dry-run` or `--yes`.
 */
export const wrap = <
  const S extends Spec,
  const Id extends keyof S['operations'] & string,
  const Flags extends Command.Command.FlagConfig,
  A,
  R = never,
>(
  spec: S,
  operationId: Id,
  {
    flags,
    fills = [],
    run,
  }: {
    readonly flags: Flags;
    readonly fills?: ReadonlyArray<keyof S['operations'][Id]['input']['Type'] & string>;
    readonly run: (context: {
      readonly flags: Command.Command.Config.InferValue<Flags>;
      readonly send: (
        values?: Partial<S['operations'][Id]['input']['Type']>,
      ) => Effect.Effect<
        S['operations'][Id]['output']['Type'],
        CliError.UserError,
        HttpClient.HttpClient
      >;
      readonly isDryRun: boolean;
    }) => Effect.Effect<A, CliError.UserError, R>;
  },
): Wrap<R> => {
  const operation = spec.operations[operationId];
  if (operation === undefined) throw new Error(`The spec has no operation ${operationId}`);
  const decode = (command: ClapioCommand, { request, status, text }: Sent) => {
    const json = parseJson(text);
    const body = text === '' ? undefined : json === undefined ? text : json;
    return Schema.decodeUnknownEffect(operation.output)(body).pipe(
      Effect.catchTag('SchemaError', error =>
        fail(unexpectedResponseFailure({ command, request, status, message: error.message })),
      ),
    );
  };
  return {
    spec,
    operationId,
    fills,
    make: (name, generated, prepare) =>
      Command.make(
        name,
        { generated, own: flags },
        Effect.fnUntraced(
          function* ({ generated, own }) {
            const { command, isDryRun, send } = yield* prepare(generated);
            const value = yield* run({
              flags: own,
              isDryRun,
              send: values =>
                Effect.flatMap(send(values), sent =>
                  Option.isSome(sent) ? decode(command, sent.value) : Effect.die(new DryRunEnded()),
                ),
            });
            if (value !== undefined && !isDryRun) {
              yield* Console.log(JSON.stringify(value, null, 2));
            }
          },
          Effect.catchDefect(defect =>
            defect instanceof DryRunEnded ? Effect.void : Effect.die(defect),
          ),
        ),
      ),
  };
};

const leafCommand = <E, R>(
  command: ClapioCommand,
  defaults: Defaults<E, R>,
  wrapped: Wrap<unknown> | undefined,
): Command.Command.Any => {
  const { name, parameters, summary, description, operationId } = command;
  const word = name.at(-1);
  if (word === undefined) throw new Error(`${operationId} has no name`);
  const ownDefaults = Object.entries(defaults).filter(([flag]) =>
    parameters.some(parameter => parameter.flag === flag),
  );
  const config = generatedConfig(
    command,
    new Set([...ownDefaults.map(([flag]) => flag), ...(wrapped?.fills ?? [])]),
  );
  const run = prepare(command, ownDefaults);
  const leaf =
    wrapped === undefined
      ? Command.make(
          word,
          config,
          Effect.fnUntraced(function* (input) {
            const { send } = yield* run(input);
            const sent = yield* send();
            const output = Option.isSome(sent) ? successOutput(sent.value.text) : undefined;
            if (output !== undefined) yield* Console.log(output);
          }),
        )
      : wrapped.make(word, config, run);
  return leaf.pipe(Command.withDescription([summary, description].filter(Boolean).join('\n\n')));
};

const discoveryCommands = (manifest: Manifest, handWritten: ReadonlyArray<Listing>) => [
  Command.make('commands', {}, () => Console.log(commandsOutput(manifest, handWritten))).pipe(
    Command.withDescription('List every command as JSON'),
  ),
  Command.make(
    'schema',
    {
      words: Argument.String('command').pipe(
        Argument.withDescription('The command, as words (`pets create`) or its operationId'),
        Argument.variadic({ min: 1 }),
      ),
    },
    Effect.fnUntraced(function* ({ words }) {
      const command = findCommand(manifest, words);
      if (command === undefined) {
        return yield* fail(
          usageFailure(`No generated command "${words.join(' ')}"; \`commands\` lists them`),
        );
      }
      yield* Console.log(schemaOutput(command));
    }),
  ).pipe(
    Command.withDescription(
      "Print a generated command's flags, request body and output as JSON Schema",
    ),
  ),
];

type Extras = { readonly [group: string]: ReadonlyArray<Command.Command.Any> };

/** The commands under `prefix`: a leaf for a command one word deep, a group for a deeper one. */
// ponytail: typed as `Command.Command.Any`, so `commands`' declared E and R go unchecked against the
// leaves; type `tree` and `leafCommand` concretely if a leaf gains a requirement.
const tree = <E, R>(
  commands: ReadonlyArray<ClapioCommand>,
  prefix: ReadonlyArray<string>,
  options: {
    readonly defaults: Defaults<E, R>;
    readonly extend: Extras;
    readonly wraps: ReadonlyMap<string, Wrap<unknown>>;
  },
): ReadonlyArray<Command.Command.Any> =>
  [...new Set(commands.map(({ name }) => name[prefix.length]))].flatMap(
    (word): ReadonlyArray<Command.Command.Any> => {
      if (word === undefined) return [];
      const path = [...prefix, word];
      const under = commands.filter(({ name }) =>
        path.every((part, index) => name[index] === part),
      );
      const leaf = under.find(({ name }) => name.length === path.length);
      if (leaf !== undefined) {
        return [leafCommand(leaf, options.defaults, options.wraps.get(leaf.operationId))];
      }
      return [
        Command.make(word).pipe(
          Command.withSubcommands([
            ...tree(under, path, options),
            ...(options.extend[path.join(' ')] ?? []),
          ]),
        ),
      ];
    },
  );

/**
 * One command per operation of the spec `clapio generate` wrote, as an effect/cli tree, plus
 * `commands` and `schema` for discovery, to put under your root command. A document a CLI can't
 * express throws (`InvalidOpenApiError` / `UnsupportedOpenApiError`, naming the operation): it is
 * the program's bug, found the first time it runs. They send through the `HttpClient` you provide,
 * which owns the base URL and the credentials
 * (`HttpClient.mapRequest(HttpClientRequest.prependUrl(apiUrl))`). Each prints its success on
 * stdout and fails as one JSON line (`{ "error": { "code", "message", … } }`).
 *
 * `defaults` fills a flag when neither it nor `--body` gives the value. `extend` adds your own
 * commands to a generated group (`{ brands: [useBrandCommand] }`). `wrap` puts your code around
 * generated commands (see `wrap`).
 */
export const commands = <
  E = never,
  R = never,
  const Extra extends Command.Command.Any = never,
  const W extends Wrap<unknown> = never,
>(
  spec: Spec,
  options: {
    readonly defaults?: Defaults<E, R>;
    readonly extend?: { readonly [group: string]: ReadonlyArray<Extra> };
    readonly wrap?: ReadonlyArray<W>;
  } = {},
): ReadonlyArray<
  Command.Command<
    string,
    unknown,
    unknown,
    CliError.UserError | E | Command.Error<Extra>,
    HttpClient.HttpClient | R | Command.Services<Extra> | WrapServices<W>
  >
> => {
  const manifest = Result.getOrThrow(fromOpenApi(spec.document));
  const { extend = {}, defaults = {}, wrap: wraps = [] } = options;

  const groups = new Set(
    manifest.commands.flatMap(({ name }) =>
      name.slice(0, -1).map((_, index) => name.slice(0, index + 1).join(' ')),
    ),
  );
  const unknownGroup = Object.keys(extend).find(group => !groups.has(group));
  if (unknownGroup !== undefined) throw new Error(`No command group "${unknownGroup}" to extend`);
  const generated = new Set(manifest.commands.map(({ name }) => name.join(' ')));
  const clash = Object.entries(extend)
    .flatMap(([group, extras]) => extras.map(({ name }) => `${group} ${name}`))
    .find(name => generated.has(name) || groups.has(name));
  if (clash !== undefined) {
    throw new Error(`"${clash}" is generated: wrap it to change what it does`);
  }

  const flags = new Set(
    manifest.commands.flatMap(({ parameters }) => parameters.map(({ flag }) => flag)),
  );
  const unknownFlag = Object.keys(defaults).find(flag => !flags.has(flag));
  if (unknownFlag !== undefined) throw new Error(`No command takes --${unknownFlag} to default`);

  const foreign = wraps.find(({ spec: own }) => own !== spec);
  if (foreign !== undefined) {
    throw new Error(`The wrap of ${foreign.operationId} was made for another spec`);
  }
  const twice = wraps.find(
    ({ operationId }, index) =>
      wraps.findIndex(other => other.operationId === operationId) !== index,
  );
  if (twice !== undefined) throw new Error(`${twice.operationId} is wrapped twice`);

  const handWritten = Object.entries(extend).flatMap(([group, extras]) =>
    extras.map(({ name, shortDescription, description }) => {
      const summary = shortDescription ?? description;
      return { command: `${group} ${name}`, ...(summary === undefined ? {} : { summary }) };
    }),
  );
  return [
    ...tree(manifest.commands, [], {
      defaults,
      extend,
      wraps: new Map(wraps.map(wrapped => [wrapped.operationId, wrapped])),
    }),
    ...discoveryCommands(manifest, handWritten),
  ];
};

type WrapServices<W> = W extends Wrap<infer R> ? R : never;
