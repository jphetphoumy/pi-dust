# Release and maintenance

This guide documents the repository automation and the commands used to maintain
the project over time.

## CI

The repository includes several GitHub Actions workflows:

- `ci.yml` -> standard quality gate on push and pull request
- `coverage.yml` -> coverage generation
- `changelog.yml` -> changelog refresh
- `release.yml` -> GitHub release publication on version tags

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

## Tagging a release

Typical flow:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow then:

- installs dependencies
- runs the quality gate
- generates the changelog
- generates release notes
- publishes the GitHub release

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
