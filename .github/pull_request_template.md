## Why

<!-- the problem or requirement, one paragraph; ticket link -->

## What

<!-- decisions, not files: "expired enrollments now reject completion (422)" -->

-

## How to verify

<!-- commands / steps a reviewer runs; for API changes an example request and response -->

## Notes

<!-- migration and its expand/contract phase · new config keys · follow-ups · known gaps -->

## Checklist

- [ ] migration SQL reviewed; destructive changes are two-phase
- [ ] new env keys in `env.schema.ts` and `.env.example`
- [ ] tests written from the requirement list, not from the code
- [ ] every new endpoint has the four mandatory e2e cases
- [ ] project decisions in `CLAUDE.md` respected or updated
