// Real HS256 tokens signed with the JWT_SECRET of .env.test: AuthGuard verifies them exactly
// as in production. Guards are never bypassed. Logging in via POST /auth/login is its own
// subject (test/identity/auth.e2e-spec.ts) and too slow (argon2) to do per request.
import { JwtService } from '@nestjs/jwt';

const jwt = new JwtService();
const secret = (): string => {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not set: is .env.test loaded?');
  return value;
};

export function tokenFor(userId: string, signWith: string = secret()): string {
  return jwt.sign({ sub: userId }, { secret: signWith, algorithm: 'HS256', expiresIn: 900 });
}

/** Headers for a request made by `userId`. */
export function asUser(userId: string): { Authorization: string } {
  return { Authorization: `Bearer ${tokenFor(userId)}` };
}

/** A correctly signed token that expired a minute ago. */
export function expiredTokenFor(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: userId, iat: now - 960, exp: now - 60 },
    { secret: secret(), algorithm: 'HS256' },
  );
}
