// The contracts against their released versions (docs/adr/0021-contract-testing.md): a
// contract changed where it stands passes every other test of the repository, because all the
// services are built from the same commit. Here it meets the build that is already deployed.
import { describe, expect, it } from 'vitest';

import { breakingChanges } from './compatibility';
import { contractKey, contracts } from './registry';
import { jsonSchemaOf, releasedKeys, releasedSample, releasedSchema } from './testing/released';

const HINT = 'run pnpm contracts:freeze';

describe.each(contracts)('$name@$version', (contract) => {
  const current = JSON.parse(JSON.stringify(jsonSchemaOf(contract))) as unknown;

  it('CTR-001 is released: its schema and a message of that day are kept', () => {
    expect(releasedSchema(contract), HINT).toBeDefined();
    expect(() => releasedSample(contract)).not.toThrow();
  });

  it('CTR-003 has changed in no way that asks for a new version', () => {
    expect(breakingChanges(releasedSchema(contract), current)).toEqual([]);
  });

  it('CTR-002 is released as it is now', () => {
    expect(current, HINT).toEqual(releasedSchema(contract));
  });

  it('CTR-004 still reads the message of the day it was released', () => {
    const sample = releasedSample(contract);

    expect(contract.schema.safeParse(sample)).toMatchObject({ success: true });
  });
});

describe('released/', () => {
  it('CTR-001 keeps no version the registry does not know', () => {
    const known = contracts.map((contract) => contractKey(contract.name, contract.version));

    expect(releasedKeys().filter((key) => !known.includes(key))).toEqual([]);
  });
});
