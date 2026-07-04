# Contributing to dv.gl

Thanks for your interest. dv.gl is pre-alpha with a single maintainer, so expect churn
and small, focused reviews.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. Every commit must be signed off, certifying that you have the right to
submit the work under the project license (Apache-2.0):

```
Signed-off-by: Your Name <your.email@example.com>
```

Add it automatically with:

```
git commit -s
```

Pull requests with unsigned commits will not be merged. Use your real name and a
reachable email address.

### Licensing rules

- All contributions are accepted under **Apache-2.0**. Do not submit code you cannot
  license that way.
- Do not copy code from AGPL or other copyleft projects. Referencing concepts and public
  documentation is fine; referencing source is not.
- New files should carry the short Apache-2.0 header comment used across the codebase.

## Development setup

Requirements: Node (see `.nvmrc`) and [pnpm](https://pnpm.io/).

```
pnpm install
pnpm build        # tsc project build across all packages
pnpm test         # vitest across all packages
pnpm lint         # biome check
pnpm typecheck    # tsc --noEmit across all packages
```

## Pull request flow

1. Fork and branch from `main`.
2. Keep changes small and scoped to one package where possible.
3. Make sure `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` pass locally.
4. Sign off every commit (`git commit -s`).
5. Open a PR using the template. CI must be green before review.

## Commit messages

Conventional-commit style: `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`, scoped to
a package where it helps (`feat(core): ...`).
