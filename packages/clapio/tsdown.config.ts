import { defineConfig, type UserConfig } from 'tsdown';

const shared: UserConfig = {
  format: ['esm'],
  platform: 'node',
  clean: true,
};

export default defineConfig([
  // The library leaves `effect` to its peer dependency, so a program that imports it runs it on its own copy.
  { ...shared, entry: { index: 'src/index.ts' }, dts: true },
  // The CLI is self-contained, `effect` and `@effect/platform-node` included: they move together, and
  // with only platform-node bundled a fresh install paired it with whatever `effect` npm resolved
  // (platform-node 4.0 imports `effect/Crypto`, which effect 4.1 removed). It also keeps
  // platform-node's `redis` peer off the machine.
  { ...shared, entry: { bin: 'src/bin.ts' }, dts: false, deps: { alwaysBundle: [/.*/] } },
]);
