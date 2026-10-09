// `pnpm contracts:check` (docs/adr/0021-contract-testing.md): the released versions against
// the ones of the base branch. The unit tests compare a contract with `released/` of the same
// commit, so a file of `released/` edited by hand, or deleted, passes them. Here every file the
// base has must still be there, its sample untouched and its schema changed only in the way
// that is allowed.
// Base = `git merge-base $CONTRACTS_BASE_REF HEAD`, ref `main` by default.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { breakingChanges } from '../dist/testing/index.js';

const RELEASED = 'packages/contracts/released';

// git reads a path as relative to where it runs: everything below runs at the root
const here = dirname(fileURLToPath(import.meta.url));
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: here,
  encoding: 'utf8',
}).trim();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const ref = process.env.CONTRACTS_BASE_REF ?? 'main';
let base;
try {
  base = git('merge-base', ref, 'HEAD').trim();
} catch {
  process.stderr.write(`✖ cannot find the merge base with ${ref}\n`);
  process.exit(1);
}

const atBase = git('ls-tree', '-r', '--name-only', base, '--', RELEASED)
  .split('\n')
  .filter((file) => file.endsWith('.json'));

const problems = [];
for (const file of atBase) {
  const name = file.slice(RELEASED.length + 1);
  const path = join(root, file);
  if (!existsSync(path)) {
    problems.push(`${name}: deleted, but messages of this version may still be in a queue`);
    continue;
  }
  const before = JSON.parse(git('cat-file', 'blob', `${base}:${file}`));
  const after = JSON.parse(readFileSync(path, 'utf8'));

  if (name.endsWith('.sample.json')) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      problems.push(`${name}: the sample of a released version was changed`);
    }
    continue;
  }
  const changes = breakingChanges(before, after);
  if (changes.length > 0) {
    problems.push(`${name}: changed since ${ref}\n${changes.map((c) => `    - ${c}`).join('\n')}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.map((line) => `✖ ${line}`).join('\n')}\n`);
  process.stderr.write('\nA released version stays as it is: put the change in a new version.\n');
  process.exit(1);
}
process.stdout.write(
  atBase.length === 0
    ? `! ${ref} has no released contract yet: nothing to compare\n`
    : `✔ ${atBase.length} released files are compatible with ${ref} (${base.slice(0, 7)})\n`,
);
