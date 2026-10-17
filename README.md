# dsh-project-backup

Full project backup and rollback for DeepSeek Harness sessions.

## What it does

Before you start working with the model, this plugin asks whether to make a
complete snapshot of the project. If you later need to undo everything the
session changed — including files that git does not track — one click restores
the project to that pre-session state.

## Backup contents

The snapshot is a full copy of the project directory, including:

- All source files
- `.git/` and git history as it was at that moment
- Untracked files and directories
- Build artifacts, lock files, logs — everything on disk

Only the backup storage directory itself and OS files are excluded.

## Storage

Backups are stored outside the project at:

```
S:\dsh-backups\<project-name>\<session-id>\
```

The backup is removed automatically after a successful restore.

## Layout

```
package.json      — main lib/index.js, exports["./client"], dsh.bundle +
                    dsh.client manifests
cordis.patch.yml  — bundle patch: inserts the { id: project-backup, name: dsh-project-backup } loader row
lib/index.js     — host plugin: exports { name, inject, meta, Config, apply }
lib/client.js     — web half in the lazy-CJS window.__ModuleLoader__ format:
                    💾 row action + "Бэкап проекта…" menu item in the
                    Workspaces sidebar, composer button, and one shared
                    modal dialog (shell.overlay) with Restore/Delete
LICENSE           — MIT license
.gitignore        — node_modules, logs, OS files
```

No build step.

## Tests

```
node tests/host-restore.test.mjs
```

Covers backup creation, byte-for-byte restore fidelity (nested dirs, `.git`,
unicode names, untracked files), restore after a host restart (via `meta.json`),
delete, prompt answer variants, and the persisted "never ask" project list.

## Install

1. In your profile `package.json`:
   - `dependencies`: `"dsh-project-backup": "link:S:/dsh-project-backup"`
   - `dsh.profile.bundles`: add `"dsh-project-backup"`
2. Run `pnpm install` in the profile directory.
3. Restart DeepSeek Harness.

## Usage

1. Open a project in DSH.
2. The plugin asks whether to back it up — confirm.
3. Work with the model as usual.
4. Restore or delete the backup from the **Workspaces** sidebar:
   - click the 💾 icon on the session row, or
   - open the session's **⋯** menu → **Бэкап проекта…**, or
   - click the **💾 Бэкапы** button in the composer.

   All three open one dialog with **Восстановить** / **Удалить** actions
   (window.confirm/prompt are not used — Electron webviews block them).

Backups are kept until you restore or delete them explicitly — closing or
stopping a session no longer removes its backup.

## Ideas for v2

- Configurable backup root path.
- Backup retention / cleanup policy.
- Selective restore (files only, git only, etc.).
