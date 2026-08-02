---
name: sc-n8n
description: "Drive the self-hosted n8n instance (https://n8n.rahmanef.com) from the CLI via @n8n/cli. List/inspect/create/update/activate workflows, check executions, manage credentials, projects, tags, variables, data-tables, and export/import packages — all over the n8n public API with an API key. Trigger on /sc-n8n, 'n8n workflow', 'n8n cli', 'list n8n workflows', 'create n8n workflow', 'n8n executions', 'n8n credential', 'connect n8n', 'self-hosted n8n'."
---

# /sc-n8n — self-hosted n8n control via @n8n/cli

Drive **n8n.rahmanef.com** (self-hosted, Dokploy) from CLI. Wrapper around the official
`@n8n/cli` binary (`n8n-cli`). No reinvented scripts — the binary is the engine.

## Instance

| Thing | Value |
|---|---|
| URL | `https://n8n.rahmanef.com` |
| Health | `curl https://n8n.rahmanef.com/healthz` → `{"status":"ok"}` |
| API key | env `N8N_API_KEY` (`~/.bashrc` line 6) — public-api JWT, no `exp` |
| CLI config | `~/.n8n-cli/config.json` (`0600`); URL already set |
| Backups | `~/backups/n8n/` — `n8n-db-YYYY-MM-DD.sql` + `n8n-workflows-*.json` |
| SSH deploy key | `~/.ssh/id_n8n` |

Binary: `~/.local/bin/n8n-cli` (`npm i -g @n8n/cli`; or zero-install `npx @n8n/cli ...`).

## Auth resolution order

1. flags `--url` / `--api-key`
2. env `N8N_URL` / `N8N_API_KEY`  ← **wins over config file**
3. `~/.n8n-cli/config.json`

⚠️ **GOTCHA: env key overrides config key.** `N8N_API_KEY` is exported in `~/.bashrc`.
Setting a new key via `n8n-cli config set-api-key` is **silently ignored** in any shell that
sourced `.bashrc`. To rotate → edit `~/.bashrc` line 6, not the config file.

⚠️ **`invalid signature (401)` = dead key, not wrong header.** n8n signs public-api keys with
`N8N_USER_MANAGEMENT_JWT_SECRET`. Redeploy that regenerates the secret kills every existing key.
Fix = regenerate in **n8n → Settings → n8n API → Create an API key**, then replace `.bashrc` line 6.
(The `~/backups/n8n/*.sql` dump holds only expired `mcp-server-api` OAuth tokens — no recoverable
public-api key.)

## Connect / verify

```bash
n8n-cli config show                 # URL + whether key set
n8n-cli workflow list --format=id-only   # smoke test; 401 => rotate key (above)
```

## Command surface

Every command supports `--help`. Formats: `--format=table|json|id-only`.

| Topic | Commands |
|---|---|
| `workflow` | list · get · create · update · delete · activate · deactivate · tags · transfer |
| `execution` | list · get · retry · stop · delete |
| `credential` | list · get · schema · create · delete · transfer |
| `project` | list · get · create · update · delete · members · add-member · remove-member |
| `tag` | list · create · update · delete |
| `variable` | list · create · update · delete |
| `data-table` | list · get · create · delete · rows · add-rows · update-rows · upsert-rows · delete-rows |
| `user` | list · get |
| `config` | set-url · set-api-key · show |
| `source-control` | pull |
| `package` (beta) | export · import |
| `audit` · `login` · `logout` · `skill` | top-level |

## Recipes

```bash
# inspect
n8n-cli workflow list
n8n-cli workflow get <id> --format=json

# only-active workflow ids
n8n-cli workflow list --format=json | jq -r '.[] | select(.active) | .id'

# create from JSON (backup format works)
cat workflow.json | n8n-cli workflow create --stdin

# recent failures
n8n-cli execution list --status=error --limit=10

# credential — see fields first, then create
n8n-cli credential schema gmailOAuth2
n8n-cli credential create --type=gmailOAuth2 --name='My Gmail' --file=cred.json

# projects
n8n-cli project create --name="My Project"
n8n-cli workflow transfer <id> --project=<projectId>

# package (beta) — portable bundle w/ deps
n8n-cli package export --workflow-id=<id> --output=export.n8np
n8n-cli package import --file=export.n8np --conflict-policy=fail

# bulk deactivate everything
n8n-cli workflow list --format=id-only | xargs -I{} n8n-cli workflow deactivate {}
```

## Backup / restore this instance

- Workflows snapshot lives at `~/backups/n8n/n8n-workflows-*.json` (array of workflow objects).
- Re-import one: `jq -c '.[N]' n8n-workflows-*.json | n8n-cli workflow create --stdin`.
- Full DB restore = `~/backups/n8n/*.sql` against the Postgres behind Dokploy (server-side, not this CLI).

## Rules

1. **Never delete workflows/executions without `--dry-run` first** where the subcommand offers it, else confirm the id.
2. **Beta CLI** — experiments/personal only, not prod-critical automation (n8n's own caveat).
3. **Key rotation edits `.bashrc` line 6**, not `config.json` (env overrides — see GOTCHA).
4. **Webhooks are live prod** — `n8n.rahmanef.com/webhook/*` feed convex-backup, dual-sync, openclaw-sync, rqa-broadcast. Don't deactivate their workflows casually.

## Linked skills
- `[[sc-dokploy]]` — the n8n app + Postgres run on Dokploy; restart/redeploy there.
- `[[sc-git]]` — cron/webhook replacement patterns overlap with n8n triggers.
