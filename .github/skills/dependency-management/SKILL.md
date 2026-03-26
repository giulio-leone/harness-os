---
name: dependency-management
description: "Dependency audit, update policy, license verification, and supply chain security practices."
---
# Dependency Management Skill

## Purpose
Ensure dependencies are secure, up-to-date, properly licensed, and not unnecessarily bloating the project.

## Use when
- Adding a new dependency
- Running periodic maintenance
- Before a release or security audit
- When build size unexpectedly increases
- When `npm audit` reports vulnerabilities

## Pre-Install Checklist (Before Adding a Dependency)

Before adding any new dependency, evaluate:

| Criterion | Requirement |
|-----------|-------------|
| **Necessity** | Can this be done with existing deps or < 50 lines of code? |
| **Maintenance** | Last commit < 6 months ago, > 1 maintainer |
| **Popularity** | > 1K weekly downloads (exceptions for niche tools) |
| **Size** | Check with `bundlephobia.com` — flag if > 50 KB gzipped |
| **License** | Must be compatible (MIT, Apache-2.0, BSD — avoid GPL in proprietary projects) |
| **Security** | No open critical/high CVEs on `npm audit` or Snyk |
| **Type support** | Has TypeScript types (built-in or `@types/*`) |

If a dependency fails 2+ criteria, prefer an alternative or implement in-house.

## Update Policy

### Semantic Versioning Rules

| Update type | Action | Timing |
|-------------|--------|--------|
| **Patch** (x.x.X) | Auto-update | Weekly |
| **Minor** (x.X.0) | Review changelog, then update | Bi-weekly |
| **Major** (X.0.0) | Full impact analysis + migration plan | On demand |

### Update Procedure
1. Run `npm outdated` to identify stale dependencies
2. Read changelogs for minor/major updates
3. Update in a dedicated branch (`chore/update-deps-<date>`)
4. Run full test suite after update
5. Check bundle size delta (flag if > 5% increase)

## Security Audit

Run regularly (at minimum before each release):

```bash
npm audit
npm audit fix        # auto-fix non-breaking patches
npm audit --omit=dev # check production deps only
```

### Severity Response

| Severity | Response time | Action |
|----------|--------------|--------|
| **Critical** | Immediate | Patch or replace dependency |
| **High** | < 24 hours | Patch, replace, or document mitigation |
| **Moderate** | Next sprint | Update or pin to patched version |
| **Low** | Best effort | Track in backlog |

## License Compliance

Maintain a list of approved licenses:

**Permissive (auto-approved)**: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense

**Restrictive (requires review)**: LGPL-*, MPL-2.0

**Prohibited (in proprietary projects)**: GPL-*, AGPL-*, SSPL

Use `npx license-checker --summary` to audit the current tree.

## Lockfile Rules
- **Always commit** `package-lock.json` (or equivalent)
- **Never delete** the lockfile to "fix" issues — investigate root cause
- **Review lockfile diffs** in PRs for unexpected transitive dependency changes

## Related Skills
- **`code-review`** — verify new deps in PR review
- **`performance-audit`** — check bundle size impact of new deps
- **`completion-gate`** — `npm audit` with no critical/high vulnerabilities

## Done Criteria
- No critical or high vulnerabilities in production dependencies
- All dependencies have compatible licenses
- Lockfile is committed and up-to-date
- Bundle size impact of new dependencies is documented

## Anti-patterns
- Adding a dependency for trivial functionality (e.g., `is-odd`)
- Ignoring `npm audit` warnings indefinitely
- Using `*` or `latest` as version ranges
- Deleting lockfile to resolve conflicts
- Installing without reviewing what the package does
