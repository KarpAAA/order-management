// One project, one file, one test at a time: the stack is one for the run, and so are its
// broker, its databases and the settings of its payment provider (docs/adr/0022).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.system-spec.ts'],
    environment: 'node',
    fileParallelism: false,
    // every scenario with its time: how long such a test takes is part of what it shows
    reporters: ['verbose'],
    // a scenario crosses four services whose relays look once a second
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // once per run: the compose project `oms-system`, built, seeded and listening
    globalSetup: ['test/setup/global.ts'],
  },
});
