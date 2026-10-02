import * as Result from 'effect/Result';
import { describe, expect, it } from 'vitest';
import type { Command, Parameter } from './manifest.ts';
import { buildRequest, type HttpRequest, type UsageError } from './request.ts';

/** The request, or the usage error's message. */
const outcome = (request: Result.Result<HttpRequest, UsageError>) =>
  Result.isSuccess(request) ? request.success : request.failure.message;

const parameter = (
  fields: Pick<Parameter, 'flag' | 'in' | 'name' | 'kind'> & Partial<Parameter>,
): Parameter => ({ isRequired: false, schema: {}, ...fields });

const storeId = parameter({
  flag: 'store-id',
  in: 'path',
  name: 'storeId',
  kind: 'string',
  isRequired: true,
});

const createPet: Command = {
  name: ['pets', 'create'],
  operationId: 'pets.create',
  method: 'post',
  path: '/stores/{storeId}/pets',
  parameters: [
    storeId,
    parameter({ flag: 'idempotency-key', in: 'header', name: 'Idempotency-Key', kind: 'string' }),
    parameter({ flag: 'name', in: 'body', name: 'name', kind: 'string', isRequired: true }),
    parameter({
      flag: 'kind',
      in: 'body',
      name: 'kind',
      kind: 'string',
      choices: ['cat', 'dog'],
      isRequired: true,
    }),
    parameter({ flag: 'age', in: 'body', name: 'age', kind: 'integer' }),
    parameter({ flag: 'tags', in: 'body', name: 'tags', kind: 'json' }),
  ],
  body: { isRequired: true, schema: { type: 'object' } },
  isDestructive: false,
  idempotencyHeader: 'Idempotency-Key',
};

const listPets: Command = {
  name: ['pets', 'list'],
  operationId: 'pets.list',
  method: 'get',
  path: '/stores/{storeId}/pets',
  parameters: [storeId, parameter({ flag: 'kind', in: 'query', name: 'kind', kind: 'json' })],
  isDestructive: false,
};

const deletePet: Command = {
  name: ['pets', 'delete'],
  operationId: 'pets.delete',
  method: 'delete',
  path: '/pets/{id}',
  parameters: [parameter({ flag: 'id', in: 'path', name: 'id', kind: 'string', isRequired: true })],
  isDestructive: true,
};

const newIdempotencyKey = () => 'key_1';

describe('buildRequest', () => {
  it('fills the path, merges field flags over --body, and mints an idempotency key', () => {
    expect(
      outcome(
        buildRequest(
          createPet,
          {
            flags: { 'store-id': 'store/1', name: 'Tom', age: '3', tags: '["indoor"]' },
            body: '{"name":"Old name","kind":"cat"}',
          },
          { newIdempotencyKey },
        ),
      ),
    ).toEqual({
      method: 'POST',
      url: '/stores/store%2F1/pets',
      headers: { 'Idempotency-Key': 'key_1', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tom', kind: 'cat', age: 3, tags: ['indoor'] }),
    });
  });

  it('keeps a given idempotency key', () => {
    const request = buildRequest(createPet, {
      flags: { 'store-id': 's', name: 'Tom', kind: 'cat', 'idempotency-key': 'mine' },
    });
    expect(Result.getOrThrow(request).headers['Idempotency-Key']).toBe('mine');
  });

  it('repeats an array query parameter and sends no body when there is none', () => {
    expect(
      outcome(buildRequest(listPets, { flags: { 'store-id': 's', kind: '["cat","dog"]' } })),
    ).toEqual({ method: 'GET', url: '/stores/s/pets?kind=cat&kind=dog', headers: {} });
  });

  it.each([
    [{ flags: { 'store-id': 's', name: 'Tom' } }, 'Missing required --kind'],
    [{ flags: { name: 'Tom', kind: 'cat' } }, 'Missing required --store-id'],
    [{ flags: { 'store-id': 's', name: 'Tom', kind: 'fish' } }, '--kind must be one of: cat, dog'],
    [
      { flags: { 'store-id': 's', name: 'Tom', kind: 'cat', age: '3.5' } },
      '--age must be an integer',
    ],
    [
      { flags: { 'store-id': 's', name: 'Tom', kind: 'cat', tags: '[oops' } },
      '--tags is not valid JSON',
    ],
    [{ flags: { 'store-id': 's', name: 'Tom', kind: 'cat', age: true } }, '--age needs a value'],
    [{ flags: { 'store-id': 's' }, body: '{nope' }, '--body is not valid JSON'],
    [
      { flags: { 'store-id': 's', name: 'Tom' }, body: '[]' },
      '--body must be a JSON object to combine with field flags',
    ],
  ])('rejects %j', (invocation, message) => {
    expect(outcome(buildRequest(createPet, invocation, { newIdempotencyKey }))).toBe(message);
  });

  it('takes a required field from --body alone', () => {
    const request = buildRequest(
      createPet,
      { flags: { 'store-id': 's' }, body: '{"name":"Tom","kind":"dog"}' },
      { newIdempotencyKey },
    );
    expect(Result.getOrThrow(request).body).toBe('{"name":"Tom","kind":"dog"}');
  });

  it('fills a flag from defaults only when neither the flag nor --body gives it', () => {
    const bodyOf = (invocation: Parameters<typeof buildRequest>[1]) => {
      const request = Result.getOrThrow(buildRequest(createPet, invocation, { newIdempotencyKey }));
      return [request.url, request.body];
    };
    const defaults = { 'store-id': 'store_d', name: 'Default' };
    expect(bodyOf({ flags: { kind: 'cat' }, defaults })).toEqual([
      '/stores/store_d/pets',
      '{"name":"Default","kind":"cat"}',
    ]);
    expect(bodyOf({ flags: { name: 'Flag', kind: 'cat' }, defaults })).toEqual([
      '/stores/store_d/pets',
      '{"name":"Flag","kind":"cat"}',
    ]);
    expect(bodyOf({ flags: {}, body: '{"name":"Body","kind":"cat"}', defaults })).toEqual([
      '/stores/store_d/pets',
      '{"name":"Body","kind":"cat"}',
    ]);
  });

  it('refuses --body on a command without one', () => {
    expect(outcome(buildRequest(deletePet, { flags: { id: 'p' }, body: '{}' }))).toBe(
      'pets delete takes no --body',
    );
  });
});
