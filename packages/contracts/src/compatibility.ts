/**
 * What a released version of a contract may still become (docs/adr/0021-contract-testing.md).
 * A message of that version is in a queue, written by a build that is gone, and a build that
 * is not deployed yet will read it; the other way round as well. So one change is left: a
 * field that is not required, added somewhere. Everything else is a new version.
 *
 * Both arguments are JSON Schema as `z.toJSONSchema()` writes it. The answer names every
 * change that is not allowed, by the path of its field; empty = compatible.
 */
export const breakingChanges = (released: unknown, current: unknown): string[] =>
  compare(released, current, '');

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];

const show = (value: unknown): string => (value === undefined ? 'none' : JSON.stringify(value));

const at = (path: string, field: string): string => (path === '' ? field : `${path}.${field}`);

/** A schema, or one of the schemas of an `anyOf`. */
function compare(released: unknown, current: unknown, path: string): string[] {
  if (!isRecord(released) || !isRecord(current)) {
    return same(released, current)
      ? []
      : [`${path}: changed (${show(released)} → ${show(current)})`];
  }

  const keywords = new Set([...Object.keys(released), ...Object.keys(current)]);
  const changes: string[] = [];
  for (const keyword of keywords) {
    const [before, after] = [released[keyword], current[keyword]];
    if (keyword === 'properties') changes.push(...compareFields(released, current, path));
    else if (keyword === 'required') continue;
    else if (keyword === 'items') changes.push(...compare(before, after, `${path}[]`));
    else if (keyword === 'anyOf') changes.push(...compareAlternatives(before, after, path));
    else if (!same(before, after)) {
      changes.push(`${path}: ${keyword} changed (${show(before)} → ${show(after)})`);
    }
  }
  return changes;
}

/** The fields of an object: none may leave, none may change, and a new one is optional. */
function compareFields(released: Json, current: Json, path: string): string[] {
  const before = isRecord(released.properties) ? released.properties : {};
  const after = isRecord(current.properties) ? current.properties : {};
  const [requiredBefore, requiredAfter] = [strings(released.required), strings(current.required)];

  const changes: string[] = [];
  for (const field of Object.keys(before)) {
    const here = at(path, field);
    if (!(field in after)) {
      changes.push(`${here}: removed`);
      continue;
    }
    if (requiredBefore.includes(field) && !requiredAfter.includes(field)) {
      changes.push(`${here}: no longer required`);
    }
    if (!requiredBefore.includes(field) && requiredAfter.includes(field)) {
      changes.push(`${here}: became required`);
    }
    changes.push(...compare(before[field], after[field], here));
  }
  for (const field of Object.keys(after)) {
    if (!(field in before) && requiredAfter.includes(field)) {
      changes.push(`${at(path, field)}: new required field`);
    }
  }
  return changes;
}

function compareAlternatives(released: unknown, current: unknown, path: string): string[] {
  if (!Array.isArray(released) || !Array.isArray(current) || released.length !== current.length) {
    return [`${path}: anyOf changed (${show(released)} → ${show(current)})`];
  }
  return released.flatMap((alternative, index) => compare(alternative, current[index], path));
}

/** Deep equality of two JSON values; the order of keys does not count. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => same(entry, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => same(a[key], b[key]));
  }
  return a === b;
}
