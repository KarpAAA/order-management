// Commit message rules: nest-conventions quality/git-pr.md §1, checked by .husky/commit-msg and
// by the `commits` job of ci.yml (a hook can be skipped, CI cannot).
// `.mjs`: the root package.json has no "type": "module".

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // the conventions' list; config-conventional also allows `style` and `revert`
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'test', 'chore', 'docs', 'perf', 'build', 'ci'],
    ],
    'header-max-length': [2, 'always', 72],
    'subject-full-stop': [2, 'never', '.'],
    // the conventions do not limit the body; Dependabot bodies carry long URLs
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
