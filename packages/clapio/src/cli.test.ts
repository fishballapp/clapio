import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, expectTypeOf, layer } from '@effect/vitest';
import * as Console from 'effect/Console';
import type * as CliError from 'effect/cli/CliError';
import * as CliOutput from 'effect/cli/CliOutput';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import { spec } from './fixtures/pets.gen.ts';
import * as Clapio from './index.ts';

/** `pets create`, taking the name from a file and adding `isWatched` to what it prints. */
const createFromFile = Clapio.wrap(spec, 'pets.create', {
  flags: {
    nameFile: Flag.String('name-file').pipe(
      Flag.withDescription('Read the name from this file'),
      Flag.optional,
    ),
    isWatched: Flag.Boolean('watch').pipe(Flag.withDefault(false)),
  },
  fills: ['name'],
  run: Effect.fn(function* ({ flags: { nameFile, isWatched }, send }) {
    const fs = yield* FileSystem.FileSystem;
    const name = Option.isSome(nameFile)
      ? (yield* fs
          .readFileString(nameFile.value)
          .pipe(
            Effect.catchTag('PlatformError', error =>
              Clapio.fail({ code: 'UsageError', message: error.message }),
            ),
          )).trim()
      : undefined;
    const pet = yield* send(name === undefined ? {} : { name });
    return isWatched ? { ...pet, isWatched } : pet;
  }),
});

/** `pets delete`, counting how often its own code ran. */
const deleteCounted = (runs: { count: number }) =>
  Clapio.wrap(spec, 'pets.delete', {
    flags: {},
    run: Effect.fn(function* ({ send }) {
      runs.count += 1;
      yield* send();
    }),
  });

/** `pets get`, catching everything `send` does and printing a value after it. */
const getCatchingAll = Clapio.wrap(spec, 'pets.get', {
  flags: {},
  run: Effect.fn(function* ({ send }) {
    const exit = yield* Effect.exit(send());
    return { isSent: Exit.isSuccess(exit) };
  }),
});

class Boom extends Data.TaggedError('Boom') {}

type Call = { url: string; method: string; headers: Headers; body: string };

const API = 'https://pets.test';

/** The CLI, a hand-written command added to `pets`, against `respond`; output is captured. */
const runCli = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  respond: (call: Call) => { status: number; body?: string } = () => ({ status: 404 }),
  wraps: ReadonlyArray<Clapio.Wrap<FileSystem.FileSystem>> = [],
) {
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = {
      url: input.toString(),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : '',
    };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(body ?? null, { status });
  };
  const adopt = Command.make('adopt', { id: Flag.String('id').pipe(Flag.optional) }, ({ id }) =>
    Option.isSome(id)
      ? Console.log(`adopted ${id.value}`)
      : Clapio.fail({ code: 'UsageError', message: 'adopt needs --id' }),
  ).pipe(Command.withDescription('Adopt a pet'));
  const cli = Command.make('pets-cli').pipe(
    Command.withSubcommands(
      Clapio.commands(spec, {
        defaults: { 'store-id': Effect.succeed(Option.some('store_1')) },
        extend: { pets: [adopt] },
        wrap: wraps,
      }),
    ),
  );
  const exit = yield* Effect.exit(Command.runWith(cli, { version: 'test' })(args)).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.effect(
          HttpClient.HttpClient,
          Effect.map(
            HttpClient.HttpClient,
            HttpClient.mapRequest(HttpClientRequest.prependUrl(API)),
          ),
        ).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
        ),
        CliOutput.layer(Clapio.withJsonErrors(CliOutput.defaultFormatter({ colors: false }))),
      ),
    ),
    Effect.provideService(Console.Console, {
      ...console,
      log: (...parts: unknown[]) => stdout.push(parts.join(' ')),
      error: (...parts: unknown[]) => stderr.push(parts.join(' ')),
    }),
  );
  return { exit, calls, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
});

/** The JSON failure line in the captured stderr. */
const failure = (stderr: string) => {
  const line = stderr.split('\n').find(text => text.includes('{"error"'));
  if (line === undefined) throw new Error(`no failure line in: ${stderr}`);
  return JSON.parse(line.slice(line.indexOf('{')));
};

layer(NodeServices.layer)(it => {
  describe('generated commands', () => {
    it.effect('send the request and print the JSON response, defaults filling absent flags', () =>
      Effect.gen(function* () {
        const { exit, calls, stdout } = yield* runCli(
          ['pets', 'create', '--name', 'Tom', '--kind', 'cat', '--is-indoor'],
          () => ({ status: 201, body: '{"id":"pet_1"}' }),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        const [call] = calls;
        expect(call?.method).toBe('POST');
        expect(call?.url).toBe(`${API}/stores/store_1/pets`);
        expect(call?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
        expect(JSON.parse(call?.body ?? '')).toEqual({ name: 'Tom', kind: 'cat', isIndoor: true });
        expect(JSON.parse(stdout)).toEqual({ id: 'pet_1' });
      }),
    );

    it.effect('read --body from a file, with field flags over it', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(yield* fs.makeTempDirectoryScoped(), 'pet.json');
        yield* fs.writeFileString(file, '{"name":"Old","kind":"dog"}');
        const { calls } = yield* runCli(
          ['pets', 'create', '--store-id', 'store_2', '--body', `@${file}`, '--name', 'Rex'],
          () => ({ status: 201 }),
        );
        expect(calls[0]?.url).toBe(`${API}/stores/store_2/pets`);
        expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ name: 'Rex', kind: 'dog' });
      }),
    );

    it.effect("fail with the API's error as one JSON line, with the key to retry with", () =>
      Effect.gen(function* () {
        const { exit, stderr, calls } = yield* runCli(
          ['pets', 'create', '--name', 'Tom', '--kind', 'cat'],
          () => ({ status: 409, body: '{"code":"PetExists","message":"Tom is taken"}' }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failure(stderr)).toEqual({
          error: {
            code: 'PetExists',
            message: 'Tom is taken',
            status: 409,
            idempotencyKey: calls[0]?.headers.get('idempotency-key'),
          },
        });
      }),
    );

    it.effect('reject a bad invocation before sending anything', () =>
      Effect.gen(function* () {
        const { exit, stderr, calls } = yield* runCli(['pets', 'create', '--kind', 'fish']);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(calls).toEqual([]);
        expect(failure(stderr)).toEqual({
          error: { code: 'UsageError', message: '--kind must be one of: cat, dog' },
        });
      }),
    );

    it.effect('print the request on --dry-run, sending nothing', () =>
      Effect.gen(function* () {
        const { stdout, calls } = yield* runCli([
          'pets',
          'create',
          '--name',
          'Tom',
          '--kind',
          'cat',
          '--idempotency-key',
          'key_1',
          '--dry-run',
        ]);
        expect(calls).toEqual([]);
        expect(JSON.parse(stdout)).toEqual({
          dryRun: {
            method: 'POST',
            url: '/stores/store_1/pets',
            headers: { 'Idempotency-Key': 'key_1', 'content-type': 'application/json' },
            body: { name: 'Tom', kind: 'cat' },
          },
        });
      }),
    );

    it.effect('refuse a destructive command without --yes', () =>
      Effect.gen(function* () {
        const refused = yield* runCli(['pets', 'delete', '--id', 'pet_1']);
        expect(refused.calls).toEqual([]);
        expect(failure(refused.stderr).error.message).toBe(
          'pets delete is destructive: pass --yes to run it',
        );
        const confirmed = yield* runCli(['pets', 'delete', '--id', 'pet_1', '--yes'], () => ({
          status: 204,
        }));
        expect(Exit.isSuccess(confirmed.exit)).toBe(true);
        expect(confirmed.calls[0]?.method).toBe('DELETE');
        expect(confirmed.stdout).toBe('');
      }),
    );

    it.effect('sit beside a hand-written command in their group, which fails the same way', () =>
      Effect.gen(function* () {
        expect((yield* runCli(['pets', 'adopt', '--id', 'pet_1'])).stdout).toBe('adopted pet_1');
        const { exit, stderr } = yield* runCli(['pets', 'adopt']);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failure(stderr)).toEqual({
          error: { code: 'UsageError', message: 'adopt needs --id' },
        });
      }),
    );

    it.effect("print effect/cli's own parse errors as a JSON line too", () =>
      Effect.gen(function* () {
        const { exit, stderr } = yield* runCli(['pets', 'create', '--nmae', 'Tom']);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failure(stderr).error).toMatchObject({ code: 'UsageError' });
        expect(failure(stderr).error.message).toContain('--nmae');
      }),
    );
  });

  describe('a wrapped command', () => {
    const PET = '{"id":"pet_1","name":"Tom","status":"waiting"}';

    /** A temporary file holding `text`. */
    const fileWith = Effect.fnUntraced(function* (text: string) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), 'name.txt');
      yield* fs.writeFileString(file, text);
      return file;
    });

    it.effect('sends its values over the typed flags and prints what `run` returns', () =>
      Effect.gen(function* () {
        const file = yield* fileWith('Tom\n');
        const { exit, calls, stdout } = yield* runCli(
          ['pets', 'create', '--name-file', file, '--name', 'Rex', '--kind', 'cat', '--watch'],
          () => ({ status: 201, body: PET }),
          [createFromFile],
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ name: 'Tom', kind: 'cat' });
        expect(calls[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
        expect(JSON.parse(stdout)).toEqual({
          id: 'pet_1',
          name: 'Tom',
          status: 'waiting',
          isWatched: true,
        });
      }),
    );

    it.effect("fails with the API's error line, or when the response breaks the spec", () =>
      Effect.gen(function* () {
        const conflict = yield* runCli(
          ['pets', 'create', '--name', 'Tom', '--kind', 'cat'],
          () => ({ status: 409, body: '{"code":"PetExists","message":"Tom is taken"}' }),
          [createFromFile],
        );
        expect(failure(conflict.stderr).error).toMatchObject({ code: 'PetExists', status: 409 });
        const empty = yield* runCli(
          ['pets', 'create', '--name', 'Tom', '--kind', 'cat'],
          () => ({ status: 201 }),
          [createFromFile],
        );
        expect(Exit.isFailure(empty.exit)).toBe(true);
        expect(failure(empty.stderr).error).toMatchObject({
          code: 'UnexpectedResponse',
          status: 201,
          idempotencyKey: empty.calls[0]?.headers.get('idempotency-key'),
        });
      }),
    );

    it.effect('sends its values over --body too', () =>
      Effect.gen(function* () {
        const file = yield* fileWith('Tom');
        const { calls } = yield* runCli(
          ['pets', 'create', '--body', '{"name":"Old","kind":"dog"}', '--name-file', file],
          () => ({ status: 201, body: PET }),
          [createFromFile],
        );
        expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ name: 'Tom', kind: 'dog' });
      }),
    );

    it.effect('refuses a destructive command without --yes before its own code runs', () =>
      Effect.gen(function* () {
        const runs = { count: 0 };
        const refused = yield* runCli(['pets', 'delete', '--id', 'pet_1'], undefined, [
          deleteCounted(runs),
        ]);
        expect(failure(refused.stderr).error.message).toBe(
          'pets delete is destructive: pass --yes to run it',
        );
        expect({ runs: runs.count, calls: refused.calls }).toEqual({ runs: 0, calls: [] });
        const confirmed = yield* runCli(
          ['pets', 'delete', '--id', 'pet_1', '--yes'],
          () => ({ status: 204 }),
          [deleteCounted(runs)],
        );
        expect(Exit.isSuccess(confirmed.exit)).toBe(true);
        expect(runs.count).toBe(1);
      }),
    );

    it.effect('refuses a missing flag before its own code runs, counting what it fills', () =>
      Effect.gen(function* () {
        const runs = { count: 0 };
        const { stderr, calls } = yield* runCli(['pets', 'delete', '--yes'], undefined, [
          deleteCounted(runs),
        ]);
        expect(failure(stderr).error.message).toBe('Missing required --id');
        expect({ runs: runs.count, calls }).toEqual({ runs: 0, calls: [] });
        const filled = yield* runCli(
          ['pets', 'create', '--name-file', yield* fileWith('Tom'), '--kind', 'cat'],
          () => ({ status: 201, body: PET }),
          [createFromFile],
        );
        expect(Exit.isSuccess(filled.exit)).toBe(true);
      }),
    );

    it.effect('prints the request on --dry-run and ends there', () =>
      Effect.gen(function* () {
        const file = yield* fileWith('Tom');
        const { exit, calls, stdout } = yield* runCli(
          ['pets', 'create', '--name-file', file, '--kind', 'dog', '--watch', '--dry-run'],
          undefined,
          [createFromFile],
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(calls).toEqual([]);
        expect(JSON.parse(stdout).dryRun.body).toEqual({ name: 'Tom', kind: 'dog' });
      }),
    );

    it.effect('prints only the request on --dry-run, even when `run` catches everything', () =>
      Effect.gen(function* () {
        const { exit, stdout } = yield* runCli(
          ['pets', 'get', '--id', 'pet_1', '--dry-run'],
          undefined,
          [getCatchingAll],
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(Object.keys(JSON.parse(stdout))).toEqual(['dryRun']);
      }),
    );

    it.effect('stops calling the flags it fills required', () =>
      Effect.gen(function* () {
        const { stdout } = yield* runCli(['pets', 'create', '--help'], undefined, [createFromFile]);
        const helpOf = (flag: string) => stdout.split('\n').find(line => line.includes(flag));
        expect(helpOf('--name ')).not.toContain('Required');
        expect(helpOf('--kind')).toContain('Required');
        expect(helpOf('--name-file')).toContain('Read the name from this file');
      }),
    );
  });

  describe('discovery', () => {
    it.effect('`commands` lists every command, hand-written ones too', () =>
      Effect.gen(function* () {
        const { stdout } = yield* runCli(['commands']);
        expect(JSON.parse(stdout)).toEqual([
          { command: 'pets list', summary: 'List pets' },
          { command: 'pets create', summary: 'Add a pet' },
          { command: 'pets get', summary: 'Get a pet' },
          { command: 'pets delete' },
          { command: 'pets adopt', summary: 'Adopt a pet' },
        ]);
      }),
    );

    it.effect('`schema` prints a command by its words or operationId', () =>
      Effect.gen(function* () {
        const byWords = yield* runCli(['schema', 'pets', 'create']);
        expect(JSON.parse(byWords.stdout).operationId).toBe('pets.create');
        const byId = yield* runCli(['schema', 'pets.delete']);
        expect(JSON.parse(byId.stdout).isDestructive).toBe(true);
        const missing = yield* runCli(['schema', 'cats']);
        expect(failure(missing.stderr).error.code).toBe('UsageError');
      }),
    );
  });

  it('refuses what the spec lacks, a generated name in `extend`, and a wrap made elsewhere', () => {
    expect(() => Clapio.commands(spec, { extend: { cats: [Command.make('adopt')] } })).toThrow(
      'No command group "cats" to extend',
    );
    expect(() =>
      Clapio.commands(spec, { defaults: { 'brand-id': Effect.succeed(Option.none()) } }),
    ).toThrow('No command takes --brand-id to default');
    expect(() => Clapio.commands(spec, { extend: { pets: [Command.make('list')] } })).toThrow(
      '"pets list" is generated: wrap it to change what it does',
    );
    expect(() => Clapio.commands({ ...spec }, { wrap: [createFromFile] })).toThrow(
      'The wrap of pets.create was made for another spec',
    );
    expect(() => Clapio.commands(spec, { wrap: [createFromFile, createFromFile] })).toThrow(
      'pets.create is wrapped twice',
    );
  });

  it('types the commands by what their defaults and hand-written commands need', () => {
    const commands = Clapio.commands(spec, {
      defaults: { 'store-id': Effect.as(FileSystem.FileSystem, Option.none()) },
      extend: {
        pets: [
          Command.make('adopt', {}, () => Effect.fail(new Boom())),
          Command.make('feed', {}, () => Effect.asVoid(Path.Path)),
        ],
      },
    });
    expectTypeOf<Command.Services<(typeof commands)[number]>>().toEqualTypeOf<
      HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
    >();
    expectTypeOf<Command.Error<(typeof commands)[number]>>().toEqualTypeOf<
      CliError.UserError | Boom
    >();
  });

  it('types a wrap by the spec', () => {
    const typed = () => {
      // @ts-expect-error: the spec has no such operation
      Clapio.wrap(spec, 'pets.adopt', { flags: {}, run: () => Effect.void });
      // @ts-expect-error: pets.get takes no --name
      Clapio.wrap(spec, 'pets.get', { flags: {}, fills: ['name'], run: () => Effect.void });
      Clapio.wrap(spec, 'pets.get', {
        flags: {},
        // @ts-expect-error: `run` fails only through `Clapio.fail`, so the failure is the JSON line
        // @effect-diagnostics-next-line missingEffectError:off
        run: () => Effect.fail(new Boom()),
      });
      Clapio.wrap(spec, 'pets.get', {
        flags: {},
        run: Effect.fn(function* ({ send }) {
          // @ts-expect-error: --nmae is no flag of pets.get
          yield* send({ nmae: 'Tom' });
          const pet = yield* send({ id: 'pet_1' });
          const status: 'waiting' | 'adopted' = pet.status;
          return status;
        }),
      });
    };
    expect(typed).toBeTypeOf('function');
  });
});
