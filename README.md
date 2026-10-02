# clapio

**OpenAPI in, agent-first CLI out.** *(clap-pio: Command Line + API + I/O.)*

clapio reads an OpenAPI 3.x document and turns every operation into a CLI command that an agent
can drive without a manual: JSON on stdout, one JSON error line on stderr, never a prompt, and the
whole command surface discoverable from the CLI itself.

It is one package, built on [Effect](https://effect.website): the commands are an
[`effect/cli`](https://effect.website) tree, and your own code around them is typed by your spec.

```sh
npm install clapio effect @effect/platform-node
```

## Quick start

**1. Generate the module your CLI is built from**, and commit it:

```sh
npx clapio generate openapi.json --out src/api.gen.ts
```

It holds the document, so the CLI never reads a spec at runtime, and each operation's input and
output as Effect Schemas, so your own code is checked against the spec. A document a CLI can't
express fails here, naming the operation. Generate it again whenever the spec changes; in CI,
generate and `git diff --exit-code` to catch a module that drifted.

**2. Build the CLI from it:**

```ts
import * as Clapio from 'clapio';
import * as Command from 'effect/cli/Command';
import * as CliOutput from 'effect/cli/CliOutput';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Layer from 'effect/Layer';
import { spec } from './api.gen.ts';

const cli = Command.make('pets').pipe(
  Command.withSubcommands([
    ...Clapio.commands(spec, {
      // Fill a flag that neither the flag nor --body gives: a stored default, an env variable.
      defaults: { 'store-id': storedStoreId },
    }),
    loginCommand,
  ]),
);

// The commands send through the HttpClient you provide: it owns the base URL and the credentials.
const PetsClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, client =>
    client.pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl('https://api.pets.dev')),
      HttpClient.mapRequest(HttpClientRequest.bearerToken(apiKey)),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

// effect/cli's own parse errors (an unknown flag) print as JSON lines too; help stays text.
const Output = CliOutput.layer(Clapio.withJsonErrors(CliOutput.defaultFormatter()));
```

## Your own commands

**Add a command to a generated group** with `extend`. Fail it with `Clapio.fail`, so its failure
is the same JSON line as every other command's:

```ts
const adopt = Command.make('adopt', { id: Flag.String('id') }, ({ id }) =>
  id === '' ? Clapio.fail({ code: 'UsageError', message: '--id is empty' }) : adoptPet(id),
).pipe(Command.withDescription('Adopt a pet'));

Clapio.commands(spec, { extend: { pets: [adopt] } });
```

**Change what a generated command does** with `wrap`: your flags beside the generated ones, and
your code around its request. `send` takes values for the generated flags, sends the request with
them over what was typed (and `--body`, and the defaults), and returns the decoded response. What
`run` returns is printed as JSON, and it fails only through `Clapio.fail`.

```ts
const createWithPhoto = Clapio.wrap(spec, 'pets.create', {
  flags: {
    photo: Flag.String('photo').pipe(Flag.withDescription('A local photo, uploaded first')),
  },
  fills: ['photo-id'], // help stops calling --photo-id required
  run: Effect.fn(function* ({ flags: { photo }, send, isDryRun }) {
    const photoId = isDryRun
      ? '<uploaded on a real run>'
      : yield* uploadPhoto(photo).pipe(
          Effect.catchTag('UploadError', error =>
            Clapio.fail({ code: 'UploadFailed', message: error.message }),
          ),
        );
    const pet = yield* send({ 'photo-id': photoId }); // typed by the spec
    return { ...pet, photoUrl: urlOf(photoId) };
  }),
});

Clapio.commands(spec, { wrap: [createWithPhoto] });
```

The operationId, the values `send` takes and what it returns are all checked against the generated
module. A wrapped command keeps `--body`, `--dry-run`, `--yes` and its idempotency key:

- every `send` of one run carries the same key, so retrying a `send` replays the write;
- a destructive command without `--yes` is refused before `run` starts;
- under `--dry-run`, `send` prints the request and ends the command; `isDryRun` lets `run` skip its
  own side effects before it, and nothing `run` returns is printed.

Your flags can't reuse a generated flag's name, and a command in `extend` can't take a generated
command's or group's name: wrap it instead.

## What every command does

```sh
pets pets create --store-id s_1 --name Tom --kind cat
pets pets create --store-id s_1 --body @pet.json --name Tom   # field flags override --body
pets pets delete --id p_1 --yes
pets commands                      # every command and its summary, as JSON
pets schema pets create            # flags, body and output schemas, as JSON
pets schema pets.create            # …or by operationId
```

- **Command names** come from the `operationId`: `pets.addVaccine` → `pets add-vaccine`. Without
  a dot, the first tag is the group: `listPets` tagged `Pets` → `pets list-pets`.
- **Flags.** Every path, query and header parameter and every top-level body property (but a
  `readOnly` one) is a kebab-case flag (`videoAssetId` → `--video-asset-id`). A flag whose schema
  is one scalar type takes its value as text, checked against that type and a string `enum`;
  anything else takes JSON. `Authorization`, `Accept` and `Content-Type` headers are the
  runtime's, never flags.
- **`--body`** takes the whole JSON body: inline, `@file`, or `-` for stdin. Field flags are merged
  over it, and a required field can come from either. A runtime's defaults come last: they fill
  only what neither gives.
- **`--dry-run`** prints `{ "dryRun": { method, url, headers, body } }` and sends nothing. The `url`
  is relative: the base URL belongs to your HttpClient.
- **`--yes`** is required by every `DELETE`. Nothing ever prompts.
- **Idempotency.** An operation with an `Idempotency-Key` header parameter (required or not) gets a
  fresh key on every run unless `--idempotency-key` is given, and a failure reports the key it sent, so a retry
  replays the write instead of repeating it.
- **Success** prints the response body on stdout: JSON pretty-printed, other text as-is, nothing
  for an empty body.
- **Failure** prints one JSON line on stderr and exits 1:

  ```json
  {"error":{"code":"PetNotFound","message":"No such pet","status":404,"idempotencyKey":"…"}}
  ```

  An API error body that is a JSON object is passed through, with `status` added. Otherwise
  `code` is `HttpError` (a non-JSON error body), `NetworkError` (no response, so a write may
  have landed), `UsageError` (the invocation was wrong; nothing was sent) or, from a wrapped
  command, `UnexpectedResponse` (the API answered with what its spec doesn't describe).

`commands` lists every command, your own included. `schema` describes a generated command (a
wrapped one too, though its own flags are only in `--help`).

## What the spec must give

`clapio generate` fails, naming the operation, when the document is malformed
(`InvalidOpenApiError`) or asks for something a CLI can't express (`UnsupportedOpenApiError`):

- every operation needs an `operationId`, and no two may map to the same command;
- a word can't be both a command and a group (`pets` and `pets all`);
- request bodies must be JSON; cookie parameters aren't supported, nor a parameter `style` or
  `explode` other than its location's default;
- every `{name}` in a path must be a declared path parameter;
- `$ref`s must be local (`#/…`), and schemas must not be recursive (each command's schemas are
  inlined so `schema` prints them standalone);
- no parameter may map to `--body`, `--dry-run`, `--yes` or an effect/cli built-in (`--help`,
  `--version`, `--wizard`, `--completions`, `--log-level`), two parameters may not share a flag,
  and no group may be named `commands` or `schema`.

Descriptions are optional, but they are the help text an agent reads: describe your operations
and your body fields.

## Licence

MIT
