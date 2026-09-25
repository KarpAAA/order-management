/** Credentials rejected → 401, generic body (never says whether the email exists). */
export class AuthenticationError extends Error {
  readonly code = 'INVALID_CREDENTIALS';

  constructor() {
    super('Invalid email or password');
    this.name = new.target.name;
  }
}
