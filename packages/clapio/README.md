# clapio

**OpenAPI in, agent-first CLI out.** Turns every operation of an OpenAPI 3.x document into an
`effect/cli` command that an agent can drive without a manual.

```sh
npx clapio generate openapi.json --out src/api.gen.ts
```

```ts
Command.make('pets').pipe(Command.withSubcommands(Clapio.commands(spec)));
```

See the [clapio README](https://github.com/fishballapp/clapio#readme) for the API, what every command does, and what a spec must
give.
