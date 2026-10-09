// `pnpm contracts:freeze` (docs/adr/0021-contract-testing.md): releases the contracts.
//  - a version with no file yet: writes its schema and its sample;
//  - a released version that changed in the one way allowed (a field that is not required):
//    writes its schema again; the sample stays as it was written on the first day;
//  - a released version that changed in any other way: refuses, and says what to do.
// Reads the built package: the root script builds it first.
import { mkdirSync, writeFileSync } from 'node:fs';

import { contractKey, contracts } from '../dist/index.js';
import {
  breakingChanges,
  exampleOf,
  jsonSchemaOf,
  RELEASED_DIR,
  releasedFile,
  releasedSchema,
} from '../dist/testing/index.js';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const say = (line) => process.stdout.write(`${line}\n`);

const refused = [];
mkdirSync(RELEASED_DIR, { recursive: true });

for (const contract of contracts) {
  const key = contractKey(contract.name, contract.version);
  const current = jsonSchemaOf(contract);
  const released = releasedSchema(contract);

  if (released === undefined) {
    const example = exampleOf(contract);
    if (example === undefined) {
      refused.push(`${key} has no example: add one to src/testing/examples.ts`);
      continue;
    }
    writeFileSync(releasedFile(contract, 'schema'), json(current));
    writeFileSync(releasedFile(contract, 'sample'), json(example));
    say(`✔ ${key}: released`);
    continue;
  }

  const changes = breakingChanges(released, current);
  if (changes.length > 0) {
    const next = `${contract.name.split('.')[1]}.v${contract.version + 1}.ts`;
    refused.push(
      `${key} is released and cannot change:\n` +
        changes.map((change) => `    - ${change}`).join('\n') +
        `\n  Put the change in a new version (${next}) and leave this one as it was.`,
    );
    continue;
  }

  if (json(released) !== json(current)) {
    writeFileSync(releasedFile(contract, 'schema'), json(current));
    say(`✔ ${key}: a compatible change, schema written again`);
  }
}

if (refused.length > 0) {
  process.stderr.write(`\n${refused.map((line) => `✖ ${line}`).join('\n\n')}\n`);
  process.exit(1);
}
say('✔ every contract is released as it is');
