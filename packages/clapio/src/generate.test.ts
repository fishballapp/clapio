import { readFile } from 'node:fs/promises';
import * as Result from 'effect/Result';
import { describe, expect, it } from 'vitest';
import pets from './fixtures/pets.json' with { type: 'json' };
import { generate } from './generate.ts';

describe('generate', () => {
  it('writes the module the CLI tests run on', async () => {
    const generated = generate(pets, { source: 'pets.json' });
    expect(Result.getOrThrow(generated)).toBe(
      await readFile(new URL('./fixtures/pets.gen.ts', import.meta.url), 'utf8'),
    );
  });

  it("refuses a document a CLI can't be built from, naming the operation", () => {
    const generated = generate(
      { ...pets, paths: { '/pets': { get: { summary: 'No operationId' } } } },
      { source: 'pets.json' },
    );
    expect(Result.isFailure(generated) && generated.failure.message).toBe(
      'GET /pets has no operationId',
    );
  });
});
