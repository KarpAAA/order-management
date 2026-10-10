// `pnpm test:rules`: the tests of the recording rules (rules/slo.test.yaml, docs/adr/0028),
// run by promtool from the image of Prometheus. A script and not a line of package.json: the
// folder is mounted by its absolute path, which every shell spells in its own way.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// the version of the Prometheus inside grafana/otel-lgtm does not matter here: the rules
// are plain PromQL
const IMAGE = 'prom/prometheus:v3.5.0';
const rules = join(dirname(fileURLToPath(import.meta.url)), 'rules');

const { status, error } = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--volume',
    `${rules}:/rules:ro`,
    '--entrypoint',
    'promtool',
    IMAGE,
    'test',
    'rules',
    '/rules/slo.test.yaml',
  ],
  { stdio: 'inherit' },
);
if (error) console.error(`docker could not be started: ${error.message}`);
process.exit(status ?? 1);
