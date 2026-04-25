# Direct WordPress Artifact Deploy

This tooling prepares controlled deployments from the VPS to the Hostinger WordPress runtime over SSH.

It does not modify WordPress by itself unless `deploy-wordpress-artifact.sh` is run without `--dry-run`.

## Remote Context

- SSH alias: `hostinger-sos`
- WordPress root: `/home/u636254023/domains/sosprescription.fr/public_html`
- Theme destination: `wp-content/themes/gp-sos-prescription/`
- Plugin destination: `wp-content/plugins/sos-prescription-v3/`

## Safety Model

The script:

- refuses unknown `--type`;
- refuses missing archives;
- validates ZIP integrity with `unzip -t`;
- verifies the archive has exactly the expected root directory;
- extracts to `/tmp/deploy-*`;
- validates the remote WordPress root and destination parent;
- creates a timestamped remote backup before real deploy;
- uses `rsync --delete` only after the backup succeeds;
- never deletes remote backups;
- never purges cache;
- never changes the database;
- never activates or deactivates plugins/themes.

## Theme Dry-Run

```bash
tools/deploy/deploy-wordpress-artifact.sh \
  --type theme \
  --archive /var/www/sosprescription/gp-sos-prescription-example.zip \
  --remote-root /home/u636254023/domains/sosprescription.fr/public_html \
  --ssh-host hostinger-sos \
  --dry-run
```

Expected archive root:

```text
gp-sos-prescription/
```

Required files:

```text
gp-sos-prescription/style.css
gp-sos-prescription/functions.php
```

## Plugin Dry-Run

```bash
tools/deploy/deploy-wordpress-artifact.sh \
  --type plugin \
  --archive /var/www/sosprescription/sosprescription-example.zip \
  --remote-root /home/u636254023/domains/sosprescription.fr/public_html \
  --ssh-host hostinger-sos \
  --dry-run
```

Expected archive root:

```text
sos-prescription-v3/
```

Required file:

```text
sos-prescription-v3/sosprescription.php
```

## Real Deploy

Remove `--dry-run` only after the dry-run output is reviewed.

Theme:

```bash
tools/deploy/deploy-wordpress-artifact.sh \
  --type theme \
  --archive /path/to/theme.zip \
  --remote-root /home/u636254023/domains/sosprescription.fr/public_html \
  --ssh-host hostinger-sos
```

Plugin:

```bash
tools/deploy/deploy-wordpress-artifact.sh \
  --type plugin \
  --archive /path/to/plugin.zip \
  --remote-root /home/u636254023/domains/sosprescription.fr/public_html \
  --ssh-host hostinger-sos
```

## Rollback

Each real deploy prints a rollback command using the timestamped backup directory.

General rollback shape:

```bash
ssh hostinger-sos "rm -rf '<destination>' && cp -a '<backup>' '<destination>'"
```

Run rollback only after confirming the backup path exists and corresponds to the intended deploy.

## Notes

- Cache purge is intentionally out of scope.
- DB changes are intentionally out of scope.
- WordPress admin changes are intentionally out of scope.
- Use a separate mission for runtime validation after deploy.
