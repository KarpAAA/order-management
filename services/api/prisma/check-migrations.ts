// Migration checks, `pnpm test:migrations` (data/migrations.md). Four steps, the first ✖ stops:
//  1. guard   — no applied migration edited, deleted or renamed; new ones sort after the base;
//  2. fresh   — every migration from scratch on an empty Postgres (Testcontainers);
//  3. drift   — that database has exactly the shape schema.prisma describes (`migrate diff`);
//  4. upgrade — the base's migrations + the base's own seed (run in a git worktree of the base),
//               then this branch's new migrations on top: SQL that fails only on data fails here.
// Base = `git merge-base $MIGRATIONS_BASE_REF HEAD`, ref `main` by default.
// Hand-written CHECKs are invisible to `migrate diff`; test/**/*.int-spec.ts cover them.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { adminQuery, databaseUrl } from '../test/setup/database-url';
import { startPostgres } from '../test/setup/postgres';

// as in vitest.config.mts: the container is reached over IPv4, by this script and by the CLI
if (!process.env.DOCKER_HOST) process.env.TESTCONTAINERS_HOST_OVERRIDE ??= '127.0.0.1';

const API_DIR = resolve(__dirname, '..');
const MIGRATIONS_DIR = join(API_DIR, 'prisma', 'migrations');

class CheckFailed extends Error {}

interface ShellOptions {
  cwd?: string;
  databaseUrl?: string;
}

interface ShellError {
  status: number | null;
  stdout: string;
  stderr: string;
}

function isShellError(err: unknown): err is ShellError {
  return typeof err === 'object' && err !== null && 'status' in err && 'stdout' in err;
}

/** Runs a command, returns stdout; a non-zero exit throws with stdout/stderr attached. */
function sh(cmd: string, { cwd = API_DIR, databaseUrl: url }: ShellOptions = {}): string {
  // An explicit URL wins over .env (process.loadEnvFile never overrides). Both names: a base
  // older than the two-role setup still migrates and seeds through DATABASE_URL.
  const env = url ? { ...process.env, DATABASE_ADMIN_URL: url, DATABASE_URL: url } : process.env;
  return execSync(cmd, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
}

/** Runs a command; a failure becomes CheckFailed carrying the command's output. */
function shOrFail(what: string, cmd: string, options?: ShellOptions): string {
  try {
    return sh(cmd, options);
  } catch (err) {
    const output = isShellError(err) ? `${err.stdout}${err.stderr}` : String(err);
    throw new CheckFailed(`${what}\n${output.trim()}`);
  }
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const ok = (step: string, detail: string) => process.stdout.write(`✔ ${step}: ${detail}\n`);
const warn = (step: string, detail: string) => process.stdout.write(`! ${step}: ${detail}\n`);

// ── 1. guard ──────────────────────────────────────────────────────────────────

function resolveBase(): { ref: string; sha: string } {
  const ref = process.env.MIGRATIONS_BASE_REF ?? 'main';
  const sha = shOrFail(`cannot find the merge base with ${ref}`, `git merge-base ${ref} HEAD`);
  return { ref, sha: sha.trim() };
}

/** Migration folders at the base commit (none if the folder did not exist yet). */
function baseMigrations(base: string): string[] {
  // a path relative to cwd: ls-tree filters by the cwd prefix, so `<rev>:<path>` lists nothing
  return lines(sh(`git ls-tree -d --name-only ${base} prisma/migrations/`))
    .map((path) => basename(path))
    .sort();
}

function currentMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Returns the migrations this branch adds on top of the base. */
function guard(base: string): string[] {
  // working tree vs base: uncommitted edits count too
  const touched = lines(sh(`git diff --name-only --diff-filter=MDR ${base} -- prisma/migrations`));
  if (touched.length > 0) {
    throw new CheckFailed(
      `guard: an applied migration was edited, deleted or renamed — add a new migration instead\n` +
        touched.map((f) => `  ${f}`).join('\n'),
    );
  }

  const inBase = baseMigrations(base);
  const added = currentMigrations().filter((name) => !inBase.includes(name));
  const lastBase = inBase.at(-1);
  const outOfOrder = lastBase ? added.filter((name) => name <= lastBase) : [];
  if (outOfOrder.length > 0) {
    throw new CheckFailed(
      `guard: new migrations sort before the base's last one (${lastBase}) — ` +
        `regenerate them with a new timestamp (migrate reset, then migrate dev)\n` +
        outOfOrder.map((n) => `  ${n}`).join('\n'),
    );
  }

  ok('guard', `${inBase.length} base migration(s) untouched, ${added.length} new`);
  if (added.length > 1) warn('guard', `${added.length} new migrations: one migration per PR`);
  return added;
}

// ── 2–3. fresh + drift ────────────────────────────────────────────────────────

function freshAndDrift(url: string): void {
  shOrFail('fresh: prisma migrate deploy failed', 'pnpm exec prisma migrate deploy', {
    databaseUrl: url,
  });
  ok('fresh', `${currentMigrations().length} migration(s) applied to an empty database`);

  const diff =
    'pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --exit-code';
  try {
    sh(diff, { databaseUrl: url });
  } catch (err) {
    // --exit-code: 2 = the diff is not empty; 1 = the command itself failed
    if (isShellError(err) && err.status === 2) {
      throw new CheckFailed(
        `drift: schema.prisma differs from what the migrations build — ` +
          `run \`prisma migrate dev\`; SQL still missing:\n${err.stdout.trim()}`,
      );
    }
    const output = isShellError(err) ? `${err.stdout}${err.stderr}` : String(err);
    throw new CheckFailed(`drift: prisma migrate diff failed\n${output.trim()}`);
  }
  ok('drift', 'the migrated database matches schema.prisma');
}

// ── 4. upgrade ────────────────────────────────────────────────────────────────

/** The base checked out next to the repo; the callback runs inside `<worktree>/services/api`. */
function withBaseWorktree(base: string, run: (apiDir: string) => void): void {
  const root = sh('git rev-parse --show-toplevel').trim();
  const worktree = join(tmpdir(), `oms-migrations-base-${process.pid}`);
  shOrFail('upgrade: git worktree add failed', `git worktree add --detach "${worktree}" ${base}`);
  try {
    shOrFail(
      'upgrade: pnpm install in the base worktree failed',
      'pnpm install --frozen-lockfile --prefer-offline --filter @oms/api...',
      { cwd: worktree },
    );
    run(join(worktree, relative(root, API_DIR)));
  } finally {
    try {
      sh(`git worktree remove --force "${worktree}"`);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
    sh('git worktree prune');
  }
}

function upgrade(base: string, added: readonly string[], url: string): void {
  if (added.length === 0) {
    ok('upgrade', 'skipped, no new migrations');
    return;
  }

  // The base's own code migrates and seeds: exactly the data the old version would have written.
  withBaseWorktree(base, (baseApiDir) => {
    const options = { cwd: baseApiDir, databaseUrl: url };
    shOrFail('upgrade: prisma generate on the base failed', 'pnpm exec prisma generate', options);
    shOrFail('upgrade: base migrations failed', 'pnpm exec prisma migrate deploy', options);
    if (existsSync(join(baseApiDir, 'prisma', 'seed.ts'))) {
      shOrFail('upgrade: base seed failed', 'pnpm exec tsx prisma/seed.ts', options);
    }
  });

  shOrFail(
    `upgrade: the new migrations fail on the base's seeded data (${added.join(', ')})`,
    'pnpm exec prisma migrate deploy',
    { databaseUrl: url },
  );
  ok('upgrade', `${added.join(', ')} applied on top of the base's seeded data`);
}

async function main(): Promise<void> {
  const base = resolveBase();
  process.stdout.write(`Base: ${base.ref} (merge base ${base.sha.slice(0, 7)})\n`);
  const added = guard(base.sha);

  const pg = await startPostgres();
  try {
    const serverUrl = databaseUrl(pg.getConnectionUri(), 'postgres');
    await adminQuery(serverUrl, 'CREATE DATABASE mig_fresh');
    await adminQuery(serverUrl, 'CREATE DATABASE mig_upgrade');

    freshAndDrift(databaseUrl(serverUrl, 'mig_fresh'));
    upgrade(base.sha, added, databaseUrl(serverUrl, 'mig_upgrade'));
  } finally {
    await pg.stop();
  }
}

main().catch((err: unknown) => {
  const message =
    err instanceof CheckFailed
      ? err.message
      : err instanceof Error
        ? (err.stack ?? err.message)
        : String(err);
  process.stderr.write(`✖ ${message}\n`);
  process.exitCode = 1;
});
