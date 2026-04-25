# Codex Review Gate

This folder provides a reproducible advisory gate around `codex review` for SOS Prescription.

The gate does not modify product code, commit, push, deploy, purge cache, or touch databases. It captures the review output under:

```text
/var/www/sosprescription/audits/01_CODEX_OPS/codex_reviews/
```

## When To Use

Run this gate before:

- product commits touching theme, plugin, React, Worker, or deployment scripts;
- real theme/plugin deployment when the diff has not already been reviewed;
- database, Prisma, or SQL-sensitive changes;
- runtime/cache/LiteSpeed patches;
- merge or push operations that affect production paths.

Do not run it by default for:

- report-only audit missions;
- screenshots, metrics, or runtime evidence files;
- generated inventories;
- empty diffs;
- purely administrative file moves in `/var/www/sosprescription/audits/`.

## Commands

Review staged, unstaged, and untracked changes:

```bash
tools/review/codex-review-gate.sh --uncommitted
```

Review the branch diff against a base ref:

```bash
tools/review/codex-review-gate.sh --base main
```

Review one existing commit:

```bash
tools/review/codex-review-gate.sh --commit <sha>
```

## Reading Reports

Reports are named:

```text
codex_review_YYYYMMDD_HHMMSS_<pid>_<mode>.txt
```

They are created with restrictive permissions because review transcripts can include sensitive diff context. They are advisory. Treat findings as input to engineering judgment, not as an automatic block on every patch.

Do not run the gate while secrets, `.env` files, private keys, or credential dumps are present in the worktree. If the Codex CLI creates local runtime artifacts such as an empty `.codex` file, do not commit them.

## Limits

`codex review` does not replace:

- `php -l`;
- `npm run build` / `npm run build:form`;
- `git diff --check`;
- `npm run mobile:visual:local`;
- deployment dry-runs;
- HTTP smoke tests;
- real iPhone / BrowserStack checks when browser behavior matters.

Use it to reduce risk before sensitive commits and deployments, especially for ownership boundary errors, runtime regressions, security issues, and missing validations.
