// Registration, login and the token check (AUTH-001…007). Here login goes through the real
// endpoint — it IS the subject; other files mint tokens with asUser().
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser, expiredTokenFor, tokenFor } from '../helpers/auth';
import { V1 } from '../helpers/paths';
import { PASSWORD, USER_BOTH, WS_ACME, WS_GLOBEX } from '../seed/ids';
import { testDb } from '../setup/db';

let api: ApiApp;
beforeAll(async () => {
  api = await createApiApp();
});
afterAll(() => api.close());

const register = (body: unknown) =>
  api
    .http()
    .post(`${V1}/auth/register`)
    .send(body as object);
const login = (body: unknown) =>
  api
    .http()
    .post(`${V1}/auth/login`)
    .send(body as object);
const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('POST /auth/register (AUTH-001…003)', () => {
  it('registers: 201 { id }, the email stored lower-cased', async () => {
    const res = await register({
      email: 'New.User@Example.TEST',
      password: 'long-enough-1',
    }).expect(201);

    const { id } = res.body as { id: string };
    expect(await testDb().user.findUniqueOrThrow({ where: { id } })).toMatchObject({
      email: 'new.user@example.test',
    });
  });

  it('409 EMAIL_ALREADY_REGISTERED for an existing email in any letter case', async () => {
    await register({ email: 'twice@example.test', password: 'long-enough-1' }).expect(201);

    const res = await register({ email: 'TWICE@example.test', password: 'long-enough-2' }).expect(
      409,
    );
    expect(res.body).toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED' });
  });

  it.each([
    ['a password of 7 chars', { email: 'a@example.test', password: 'short12' }, 'password'],
    ['a password of 129 chars', { email: 'a@example.test', password: 'p'.repeat(129) }, 'password'],
    ['an invalid email', { email: 'not-an-email', password: 'long-enough-1' }, 'email'],
    [
      'an email over 254 chars',
      { email: `${'e'.repeat(250)}@x.test`, password: 'long-enough-1' },
      'email',
    ],
    [
      'an unknown field',
      { email: 'a@example.test', password: 'long-enough-1', admin: true },
      'admin',
    ],
  ])('400 for %s', async (_name, body, path) => {
    const res = await register(body).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      (res.body as { details: { fields: { path: string }[] } }).details.fields.map((f) => f.path),
    ).toContain(path);
  });
});

describe('POST /auth/login (AUTH-004, AUTH-005)', () => {
  it('returns an HS256 access token with sub, iat, exp, jti and nothing personal', async () => {
    const res = await login({ email: 'both@example.test', password: PASSWORD }).expect(200);

    const { accessToken, expiresIn } = res.body as { accessToken: string; expiresIn: number };
    expect(expiresIn).toBe(Number(process.env.JWT_ACCESS_TTL_SECONDS));

    const [header, payload] = accessToken.split('.') as [string, string];
    expect(decode(header)).toMatchObject({ alg: 'HS256' });
    const claims = decode(payload);
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'jti', 'sub']);
    expect(claims.sub).toBe(USER_BOTH);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(expiresIn);

    // and the token opens the API
    await api.http().get(`${V1}/me`).set('Authorization', `Bearer ${accessToken}`).expect(200);
  });

  it('401 INVALID_CREDENTIALS with the same body for a wrong password and an unknown email', async () => {
    const wrongPassword = await login({
      email: 'both@example.test',
      password: 'Wrong-pass-1',
    }).expect(401);
    const unknownEmail = await login({ email: 'nobody@example.test', password: PASSWORD }).expect(
      401,
    );

    expect(wrongPassword.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });
});

describe('the token check (AUTH-006)', () => {
  // one route here; every endpoint × no token is the matrix of 1.8
  it.each([
    ['no Authorization header', undefined],
    ['a non-Bearer scheme', `Basic ${tokenFor(USER_BOTH)}`],
    ['a malformed token', 'Bearer not.a.jwt'],
    [
      'a token signed with another secret',
      `Bearer ${tokenFor(USER_BOTH, 'another-secret-0123456789abcdef-0123')}`,
    ],
    ['an expired token', `Bearer ${expiredTokenFor(USER_BOTH)}`],
  ])('401 UNAUTHORIZED for %s', async (_name, authorization) => {
    const req = api.http().get(`${V1}/me`);
    if (authorization) void req.set('Authorization', authorization);

    const res = await req.expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('GET /me (AUTH-007)', () => {
  it('returns the user and every membership with its own role', async () => {
    const { body } = await api.http().get(`${V1}/me`).set(asUser(USER_BOTH)).expect(200);

    expect(body).toMatchObject({
      id: USER_BOTH,
      email: 'both@example.test',
      createdAt: expect.any(String),
    });
    const memberships = (body as { memberships: { workspaceId: string }[] }).memberships;
    expect([...memberships].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
      { workspaceId: WS_ACME, workspaceName: 'Acme Corp', workspaceSlug: 'acme', role: 'MEMBER' },
      { workspaceId: WS_GLOBEX, workspaceName: 'Globex', workspaceSlug: 'globex', role: 'VIEWER' },
    ]);
  });
});
