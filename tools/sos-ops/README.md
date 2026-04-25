# SOS Ops Wrappers

This directory contains small, conservative wrappers around recurring SOS operations. They provide stable command names for Codex missions and reduce prompt-level ambiguity.

These wrappers do not grant new permissions. They only route to already versioned tools.

## Wrappers

Run local mobile visual QA:

```bash
tools/sos-ops/sos-mobile-visual-local.sh
```

Run the Codex review gate on uncommitted changes:

```bash
tools/sos-ops/sos-codex-review-uncommitted.sh
```

## Intended Next Wrappers

Planned but not created in this POC:

- `sos-post-deploy-smoke.sh`
- `sos-package-theme.sh`
- `sos-package-plugin.sh`
- `sos-deploy-theme-dry-run.sh`
- `sos-deploy-plugin-dry-run.sh`

## Rules

- No real deployment from this folder unless a dedicated mission explicitly authorizes it.
- No cache purge.
- No WordPress admin mutation.
- No DB mutation.
- No secrets in scripts or output.
- Use the Codex review gate before sensitive product commits or deployments.
