# Release and maintenance

This guide documents the repository automation and the commands used to maintain
the project over time.

## CI

The repository includes several GitHub Actions workflows:

- `ci.yml` -> lint, typecheck, tests, package smoke test, and release-readiness checks on pull requests and branch pushes
- `coverage.yml` -> coverage generation and artifact upload on pull requests and branch pushes
- `release.yml` -> validated GitHub release publication on version tags

## Dependency updates

Dependabot is enabled for:

- npm dependencies
- GitHub Actions

## Changelog management

The changelog is generated with `git-cliff`.

Generate it locally:

```bash
npm run changelog
```

Generate release notes for the current version:

```bash
npm run changelog:release-notes
```

Validate the generated release notes:

```bash
npm run validate:release-notes
```

## Version bumping

The repository keeps the version in `package.json` as the source of truth.

Use one of the dedicated bump commands before creating a release tag:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

These commands update `package.json` without creating a commit or tag for you.
This keeps the release preparation explicit and reviewable.

## Recommended release flow

Typical local flow:

```bash
npm run check
npm run release:patch
npm run changelog
npm run changelog:release-notes
npm run validate:release-notes
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): prepare vX.Y.Z"
git tag vX.Y.Z
git push origin HEAD --follow-tags
```

## Tagging a release

When a tag is pushed, the release workflow validates that:

- the Git tag matches `package.json` exactly
- the standard quality gate passes
- `CHANGELOG.md` can be generated
- `RELEASE_NOTES.md` is non-empty and valid

The release workflow then:

- installs dependencies
- validates the tag version
- runs the quality gate
- generates release notes with the `orhun/git-cliff-action`
- validates the generated release notes
- generates a changelog artifact with the same `git-cliff` configuration
- validates release notes
- uploads release artifacts
- publishes the GitHub release from validated artifacts

The regular CI workflow also runs a release-readiness job on branch pushes and
pull requests so changelog generation failures are caught before tagging.

## Repository hygiene

The project enforces quality before code leaves a workstation:

- `pre-commit` runs the standard quality gate
- `pre-push` runs typecheck, lint, and coverage
- `commit-msg` validates Conventional Commits

## Important files

- `cliff.toml` -> `git-cliff` configuration
- `commitlint.config.cjs` -> Conventional Commit rules
- `.github/dependabot.yml` -> dependency update policy
- `.github/workflows/*.yml` -> CI and release automation
- `package.json` -> project version and release helper scripts
