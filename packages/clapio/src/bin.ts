#!/usr/bin/env node
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Argument from 'effect/cli/Argument';
import * as CliConfig from 'effect/cli/CliConfig';
import * as CliError from 'effect/cli/CliError';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as GlobalFlag from 'effect/cli/GlobalFlag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Result from 'effect/Result';
import packageJson from '../package.json' with { type: 'json' };
import { generate } from './generate.ts';
import { parseJson } from './json.ts';

const userError = (message: string) =>
  Effect.fail(new CliError.UserError({ cause: message, userMessage: message }));

const generateCommand = Command.make(
  'generate',
  {
    spec: Argument.String('spec').pipe(Argument.withDescription('The OpenAPI document, as JSON')),
    out: Flag.String('out').pipe(
      Flag.withDescription('Where to write the module (`src/api.gen.ts`); commit it'),
    ),
  },
  Effect.fnUntraced(function* ({ spec, out }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs
      .readFileString(spec)
      .pipe(Effect.catchTag('PlatformError', error => userError(error.message)));
    const document = parseJson(text);
    if (document === undefined) return yield* userError(`${spec} is not JSON`);
    const generated = generate(document, { source: path.relative(path.dirname(out), spec) });
    if (Result.isFailure(generated)) return yield* userError(generated.failure.message);
    yield* fs
      .writeFileString(out, generated.success)
      .pipe(Effect.catchTag('PlatformError', error => userError(error.message)));
  }),
).pipe(
  Command.withDescription(
    'Write the module `Clapio.commands` builds a CLI from: the OpenAPI document, and each operation as Effect Schemas',
  ),
);

Command.run(
  Command.make('clapio').pipe(
    Command.withDescription('OpenAPI in, agent-first CLI out'),
    Command.withSubcommands([generateCommand]),
  ),
  { version: packageJson.version },
).pipe(
  Effect.provide(
    Layer.merge(
      CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
      NodeServices.layer,
    ),
  ),
  NodeRuntime.runMain,
);
