/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { contractKey } from '../registry';

import type { Contract } from '../registry';

type Versioned = Pick<Contract, 'name' | 'version'>;

/**
 * The released versions of the contracts (docs/adr/0021-contract-testing.md): for each, its
 * schema as it was on the day it was released and one message of that day. Written by
 * `pnpm contracts:freeze`, never by hand. `src/testing` and `dist/testing` are both two
 * folders below the package.
 */
export const RELEASED_DIR = join(__dirname, '..', '..', 'released');

export const releasedFile = ({ name, version }: Versioned, kind: 'schema' | 'sample'): string =>
  join(RELEASED_DIR, `${name}.v${version}${kind === 'sample' ? '.sample' : ''}.json`);

/** What a message of this contract may look like on the wire, as JSON Schema. */
export const jsonSchemaOf = (contract: Contract): unknown =>
  z.toJSONSchema(contract.schema, { io: 'input' });

const read = (file: string): unknown =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined;

/** `undefined` for a version that was never released. */
export const releasedSchema = (contract: Versioned): unknown =>
  read(releasedFile(contract, 'schema'));

/** A message of this version as a sender wrote it on the day the version was released. */
export const releasedSample = (contract: Versioned): unknown => {
  const sample = read(releasedFile(contract, 'sample'));
  if (sample === undefined) {
    const key = contractKey(contract.name, contract.version);
    throw new Error(`${key} was never released: run pnpm contracts:freeze`);
  }
  return sample;
};

/** `name@version` of every released schema, from the names of the files. */
export const releasedKeys = (): string[] =>
  (existsSync(RELEASED_DIR) ? readdirSync(RELEASED_DIR) : []).flatMap((file) => {
    const match = /^(.+)\.v(\d+)\.json$/.exec(file);
    return match?.[1] && match[2] ? [contractKey(match[1], Number(match[2]))] : [];
  });
