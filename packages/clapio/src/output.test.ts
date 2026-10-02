import { describe, expect, it } from 'vitest';
import type { Command, Manifest } from './manifest.ts';
import { findCommand, responseFailure, successOutput } from './output.ts';
import type { HttpRequest } from './request.ts';

const createPet: Command = {
  name: ['pets', 'create'],
  operationId: 'pets.create',
  method: 'post',
  path: '/pets',
  parameters: [],
  isDestructive: false,
  idempotencyHeader: 'idempotency-key',
};
const manifest: Manifest = {
  clapio: 1,
  openapi: '3.1.0',
  title: 'Pets',
  version: '1.0.0',
  commands: [createPet],
};
const request: HttpRequest = {
  method: 'POST',
  url: '/pets',
  headers: { 'idempotency-key': 'key_1' },
};

describe('responseFailure', () => {
  it("keeps the API's own error fields, with the status and the key to retry with", () => {
    expect(
      responseFailure({
        command: createPet,
        request,
        status: 404,
        text: '{"code":"StoreNotFound","message":"No such store","storeId":"s"}',
      }),
    ).toEqual({
      code: 'StoreNotFound',
      message: 'No such store',
      storeId: 's',
      status: 404,
      idempotencyKey: 'key_1',
    });
  });

  it('keeps code and message strings when the API sends other types', () => {
    expect(
      responseFailure({
        command: createPet,
        request,
        status: 400,
        text: '{"code":400,"detail":"x"}',
      }),
    ).toMatchObject({ code: 'HttpError', message: '{"code":400,"detail":"x"}', detail: 'x' });
  });

  it('carries a body that is not JSON as its message', () => {
    expect(
      responseFailure({ command: createPet, request, status: 502, text: 'Bad gateway' }),
    ).toMatchObject({ code: 'HttpError', message: 'Bad gateway', status: 502 });
  });
});

describe('successOutput', () => {
  it('pretty-prints JSON, passes text through, and prints nothing for no body', () => {
    expect(successOutput('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(successOutput('plain')).toBe('plain');
    expect(successOutput('')).toBeUndefined();
  });
});

describe('findCommand', () => {
  it('finds a command by its words or its operationId', () => {
    expect(findCommand(manifest, ['pets', 'create'])).toBe(createPet);
    expect(findCommand(manifest, ['pets.create'])).toBe(createPet);
    expect(findCommand(manifest, ['pets'])).toBeUndefined();
  });
});
