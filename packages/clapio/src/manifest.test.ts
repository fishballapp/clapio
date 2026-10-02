import * as Result from 'effect/Result';
import { describe, expect, it } from 'vitest';
import { fromOpenApi } from './manifest.ts';

const document = (paths: object, extra: object = {}) => ({
  openapi: '3.1.0',
  info: { title: 'Pets', version: '1.0.0' },
  paths,
  ...extra,
});

const PET = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'What the pet answers to' },
    kind: { type: 'string', enum: ['cat', 'dog'] },
    age: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'kind'],
};

const build = (input: unknown) => Result.getOrThrow(fromOpenApi(input));

/** The message `fromOpenApi` fails with. */
const failureOf = (input: unknown) => {
  const result = fromOpenApi(input);
  return Result.isFailure(result) ? result.failure.message : undefined;
};

describe('fromOpenApi', () => {
  it('names a dotted operationId by its words, and a plain one under its first tag', () => {
    const manifest = build(
      document({
        '/pets/vaccines': { post: { operationId: 'pets.addVaccines' } },
        '/owners': { get: { operationId: 'listOwners', tags: ['Owners'] } },
        '/health': { get: { operationId: 'health' } },
      }),
    );
    expect(manifest.commands.map(({ name }) => name)).toEqual([
      ['pets', 'add-vaccines'],
      ['owners', 'list-owners'],
      ['health'],
    ]);
  });

  it('turns parameters and top-level body properties into flags, $refs inlined', () => {
    const manifest = build(
      document(
        {
          '/stores/{storeId}/pets': {
            parameters: [{ name: 'storeId', in: 'path', schema: { type: 'string' } }],
            post: {
              operationId: 'pets.create',
              parameters: [
                { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
                { name: 'Authorization', in: 'header', schema: { type: 'string' } },
                { name: 'dryRunUpstream', in: 'query', schema: { type: 'boolean' } },
              ],
              requestBody: {
                required: true,
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
              },
              responses: {
                '201': {
                  content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
                },
              },
            },
          },
        },
        { components: { schemas: { Pet: PET } } },
      ),
    );
    const [command] = manifest.commands;
    expect(command?.idempotencyHeader).toBe('Idempotency-Key');
    expect(command?.output).toEqual(PET);
    expect(command?.body).toEqual({ isRequired: true, schema: PET });
    expect(
      command?.parameters.map(({ flag, in: location, kind, choices, isRequired }) => ({
        flag,
        location,
        kind,
        choices,
        isRequired,
      })),
    ).toEqual([
      { flag: 'store-id', location: 'path', kind: 'string', choices: undefined, isRequired: true },
      {
        flag: 'idempotency-key',
        location: 'header',
        kind: 'string',
        choices: undefined,
        isRequired: false,
      },
      {
        flag: 'dry-run-upstream',
        location: 'query',
        kind: 'boolean',
        choices: undefined,
        isRequired: false,
      },
      { flag: 'name', location: 'body', kind: 'string', choices: undefined, isRequired: true },
      { flag: 'kind', location: 'body', kind: 'string', choices: ['cat', 'dog'], isRequired: true },
      { flag: 'age', location: 'body', kind: 'integer', choices: undefined, isRequired: false },
      { flag: 'tags', location: 'body', kind: 'json', choices: undefined, isRequired: false },
    ]);
    expect(command?.parameters.find(({ flag }) => flag === 'name')?.description).toBe(
      'What the pet answers to',
    );
  });

  it('marks a DELETE destructive', () => {
    const manifest = build(document({ '/pets': { delete: { operationId: 'pets.delete' } } }));
    expect(manifest.commands[0]?.isDestructive).toBe(true);
  });

  it('refuses what a CLI cannot express', () => {
    expect(failureOf(document({ '/pets': { get: {} } }))).toContain('has no operationId');
    expect(
      failureOf(
        document({
          '/pets': {
            post: {
              operationId: 'pets.create',
              requestBody: {
                content: { 'application/json': { schema: { properties: { body: {} } } } },
              },
            },
          },
        }),
      ),
    ).toContain('--body is reserved');
    expect(
      failureOf(
        document({
          '/pets': { get: { operationId: 'pets' } },
          '/pets/all': { get: { operationId: 'pets.all' } },
        }),
      ),
    ).toContain('"pets" is both a command and a command group');
    expect(
      failureOf(
        document(
          {
            '/nodes': {
              get: {
                operationId: 'nodes.list',
                responses: {
                  '200': {
                    content: {
                      'application/json': { schema: { $ref: '#/components/schemas/Node' } },
                    },
                  },
                },
              },
            },
          },
          {
            components: {
              schemas: {
                Node: {
                  properties: { children: { items: { $ref: '#/components/schemas/Node' } } },
                },
              },
            },
          },
        ),
      ),
    ).toContain('Recursive schemas are not supported');
  });
  it('reads common string shapes as string flags, and a one-$ref allOf as its target', () => {
    const [command] = build(
      document(
        {
          '/models': {
            post: {
              operationId: 'models.pick',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      properties: {
                        model: {
                          anyOf: [{ type: 'string' }, { type: 'string', enum: ['a', 'b'] }],
                        },
                        status: {
                          allOf: [{ $ref: '#/components/schemas/Status' }],
                          description: 'd',
                        },
                        anything: {},
                        id: { type: 'string', readOnly: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        { components: { schemas: { Status: { type: 'string', enum: ['on', 'off'] } } } },
      ),
    ).commands;
    expect(command?.parameters.map(({ flag, kind, choices }) => ({ flag, kind, choices }))).toEqual(
      [
        { flag: 'model', kind: 'string', choices: undefined },
        { flag: 'status', kind: 'string', choices: ['on', 'off'] },
        { flag: 'anything', kind: 'json', choices: undefined },
      ],
    );
  });

  it('never requires the idempotency key, and overrides a header whatever its case', () => {
    const [command] = build(
      document({
        '/pets': {
          parameters: [{ name: 'X-Tenant', in: 'header', schema: { type: 'string' } }],
          post: {
            operationId: 'pets.create',
            parameters: [
              { name: 'x-tenant', in: 'header', required: true, schema: { type: 'string' } },
              { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
            ],
            responses: {
              '2XX': { content: { 'application/json': { schema: { type: 'object' } } } },
            },
          },
        },
      }),
    ).commands;
    expect(command?.parameters.map(({ name, isRequired }) => ({ name, isRequired }))).toEqual([
      { name: 'x-tenant', isRequired: true },
      { name: 'Idempotency-Key', isRequired: false },
    ]);
    expect(command?.output).toEqual({ type: 'object' });
  });

  it('refuses a parameter style it would send wrong, and an undeclared path parameter', () => {
    expect(
      failureOf(
        document({
          '/pets': {
            get: {
              operationId: 'pets.list',
              parameters: [{ name: 'ids', in: 'query', explode: false, schema: { type: 'array' } }],
            },
          },
        }),
      ),
    ).toContain("pets.list: ids needs a parameter style clapio doesn't send");
    expect(failureOf(document({ '/pets/{id}': { get: { operationId: 'pets.get' } } }))).toContain(
      'pets.get: the path parameter {id} is not declared',
    );
  });
  it('resolves $ref parameters, and names what is malformed', () => {
    const [command] = build(
      document(
        {
          '/pets/{id}': {
            get: { operationId: 'pets.get', parameters: [{ $ref: '#/components/parameters/Id' }] },
          },
        },
        {
          components: {
            parameters: { Id: { name: 'id', in: 'path', schema: { type: 'string' } } },
          },
        },
      ),
    ).commands;
    expect(command?.parameters.map(({ flag }) => flag)).toEqual(['id']);
    expect(failureOf(document({ '/pets': { get: { operationId: 5 } } }))).toContain('document');
    expect(
      failureOf(
        document({
          '/pets': { get: { operationId: 'pets.list', parameters: [{ $ref: '#/nope' }] } },
        }),
      ),
    ).toBe('Unresolvable $ref: #/nope');
  });
});
