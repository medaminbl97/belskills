# Operations: first install, secrets model, validation, recovery

## 1. First-install walkthrough

Prerequisites (verify, do not assume): Python 3.8+, Terraform ≥ 1.11 (write-only
secrets need it; preflight checks), Make, optionally SSH with Docker-inspection
rights on the host (`DOKPLOY_SSH`; without it readiness rests on Dokploy's
deployment status and the HTTP checks, and a failed database job only shows up as
a backend whose health check times out), Dokploy ≥ 0.31.0, Docker Compose ≥
2.23.1 on the host, external network `dokploy-network`, DNS for every hostname
with 80/443 reaching Traefik and valid TLS (never disable certificate
verification), and a Dokploy GitHub App already installed with access to every
application repository and a webhook reaching Dokploy.

```sh
cp .env.example .env && chmod 600 .env     # DOKPLOY_ENDPOINT, DOKPLOY_API_KEY, DOKPLOY_SSH, PLATFORM_NAME
cp terraform/bootstrap/projects/terraform.tfvars.example          terraform/bootstrap/projects/terraform.tfvars
cp terraform/bootstrap/infisical/service/terraform.tfvars.example terraform/bootstrap/infisical/service/terraform.tfvars
cp terraform/bootstrap/secrets/dev.tfvars.example                 terraform/bootstrap/secrets/dev.tfvars
cp terraform/projects/<project>/secrets/dev.tfvars.example        terraform/projects/<project>/secrets/dev.tfvars
cp terraform/projects/<project>/apps/dev.tfvars.example           terraform/projects/<project>/apps/dev.tfvars
# if OIDC is enabled also: terraform/bootstrap/oidc/service/dev.tfvars
# edit every copy; set consumer_projects to ALL products, not just this run's
```

1. `make bootstrap-global`: preflight, `projects`, `infisical`, interactive
   `infisical-bootstrap` (first run only), `infisical-project`.
2. `make infisical-recovery`: print `ENCRYPTION_KEY`/`AUTH_SECRET` **once,
   privately**; store them in a tested backup immediately. No recovery without them.
3. `make bootstrap-env ENV=dev`: `platform-secrets` and, if enabled, `postgres`,
   `oidc-database`, `oidc`. *If OIDC is enabled*, a human then completes the
   provider's first-admin setup in its UI, creates a dedicated client per project
   (redirect URI from that app's docs), and puts the real client ID/secret into
   the project's `secrets/dev.tfvars` (never into a committed `.example`).
4. `make project-secrets ENV=dev PROJECT=<project>`, then (if enabled)
   `make project-databases ENV=dev PROJECT=<project>`.
5. **First-install ordering (chicken and egg), only if unavoidable.** First try to
   remove it: if the backend can read its service token from an environment
   variable and apply it at startup (Directus: `token_env` on the service user),
   generate that token in the project's `secrets` layer and inject the same value
   into the consumer. The token then exists before the backend does and this
   whole step disappears. Only when the issuing system mints the value itself
   (the frontend needs a token *issued by the deployed backend*), the apps root's
   `lifecycle.precondition` will refuse to plan until it exists.
   Resolve it explicitly and reviewably; do not fake a value:
   - Temporarily scope the root to the backend only (comment out the frontend
     resource, its precondition and outputs), or use a short-lived secondary
     module invocation. **Never use `-target`** (the orchestrator forbids it).
   - `make project-apps ENV=dev PROJECT=<project>` to bring up the backend alone.
   - Sign in, create one least-privilege read-only token per consuming app, add
     each to its `/<project>/<app>` vault folder.
   - Restore the full root, review `make plan STACK=apps ...`, then run the full
     `make project-apps`. Skip this step entirely if no component needs a token
     issued by another component.
6. From now on `make project-deploy ENV=dev PROJECT=<project>` reruns
   secrets→[databases]→apps. `make full ENV=dev PROJECTS="<project>"` repeats the
   global/stage bootstrap too (idempotent; unchanged layers are skipped). Repeat
   steps 3–5 independently for `prod` (separate clients, separate tokens, separate
   state) before any `ENV=prod` run; `ENV=all` is two runs, not a shortcut around
   the manual steps.
7. *If OIDC is enabled:* verify local login still works and link and test one
   OIDC-backed administrator (matching the application's external-identifier
   rule) before disabling any local/default login. Requesting a `groups` scope
   does not by itself map groups to application roles; configure that mapping.

## 2. Secrets, state and recovery model

- **Generated** (`ephemeral "random_password"` + `value_wo`/`value_wo_version`):
  manual edits in the vault persist across re-apply; bump a layer's
  `credential_version` to regenerate **every** generated secret in that layer
  (deliberately coarse; add a per-secret knob only if needed).
- **Configured** (plain `value` from tfvars): always reapplied from tfvars. Change
  them there, not in the vault UI, or they are overwritten.
- **Manual** (app read tokens, CI runner tokens): Terraform creates only the empty
  folder and never overwrites a value a human puts there. Document the split
  loudly; it is easy to assume Terraform owns everything in a folder it created.
- Dokploy has no vault integration: roots read `data.infisical_secrets.*` and
  inject values into Dokploy environment variables, so each value lives **both**
  in Terraform state and in Dokploy's database. Treat both as sensitive; plans
  show `(sensitive value)`. After changing a vault value, redeploy the consuming
  layer; Dokploy will not notice on its own.
- Rotating the PostgreSQL superuser secret alone does **not** change an
  initialized volume's password (Postgres reads it only on first init). Rotate via
  SQL, then update the secret.
- Hand-edited secrets destined for a Compose `env` string: letters and digits
  only; `$` and newlines are unsafe.
- `STATE_DIR` (default `.state`) holds `states/<root>/<stage>.tfstate`, a
  per-root-per-stage `TF_DATA_DIR` under `data/`, and one shared flock-protected
  provider cache under `providers/`. Changing `STATE_DIR` is not a migration
  tool. Back up `.state/`, `.env` and every database/volume together with the
  vault recovery keys, on an encrypted access-controlled disk, and test restores.
  Vault and Postgres Compose volumes are retained on `destroy`; removing them is a
  separate human-approved procedure.

## 3. Validation, troubleshooting, destruction

(Section 4, after this one, covers host reboots and decommissioning.)

- `make validate PROJECT=<project>` initializes and validates every active root
  without a backend or live-service connection (may download providers).
- `make plan STACK=<layer> ENV=dev PROJECT=<project>` needs that layer's
  prerequisites to have a `.deployed` marker; the error names the missing one.
- Applies always show a saved plan and require typed confirmation unless
  `TF_APPLY_ARGS=-auto-approve` is set explicitly for that invocation. `-target`
  is rejected.
- `make destroy STACK=<layer> ENV=dev PROJECT=<project>` refuses while any
  downstream layer still has resources in its state; destroy in reverse
  dependency order, one layer at a time. Shared volumes are retained regardless.
- **Readiness/timeout failures:** inspect the correlated Dokploy deployment
  (unique `<platform>-stack:<uuid>` description) and, for applications, the Swarm
  service's `UpdateStatus`/running tasks. A timeout means the *queued* job is still
  running or stuck, not cancelled; do not blindly retry.
- **Missing GitHub provider:** the exact `github_app_name` must match an installed
  Dokploy GitHub App with access to the repo and a webhook delivering push
  events. Terraform cannot create or install the App.
- **OIDC discovery failures** (if enabled): confirm reachable HTTPS, that the
  provider finished its first-run setup, and that the discovery `issuer` exactly
  matches the configured `issuer`.
- **Provisioning job failures:** inspect the job's (protected) container logs
  privately; causes are usually wrong host/network/credentials, not the SQL (it is
  idempotent and safe to rerun).
- Before trusting this skill on anything affecting production, re-read the live
  Makefile, `make/`, orchestrator scripts, `modules/database` and an existing
  project's roots in the repo you are working in.

## 4. Host reboots, redeploys and decommissioning

**Reboot resilience** (learned the hard way: Compose stacks without a restart
policy stayed down after a reboot):

- Stateful Compose services (vault, its Postgres and Redis, shared Postgres) use
  `restart: always`. One-shot jobs (the database job) use `restart: "no"`, or
  they re-run on every boot. Swarm applications restart themselves.
- `depends_on` (even with `service_healthy`) only orders `docker compose up`.
  After a reboot Docker restarts every container independently, so a consumer
  must wait or retry itself: `restart: always` for Compose services; for an app
  that crashes without its database, a startup wait loop in its entrypoint
  (e.g. poll `DB_HOST:DB_PORT` up to `DB_WAIT_SECONDS`, default 300).
- No app should depend on the vault at runtime: secrets are injected at deploy
  time, so a vault that starts late does not stop the apps.
- The host must start Docker at boot (`systemctl is-enabled docker`) and Dokploy
  itself must come back; check both once and say so in the repo README.
- A stack deployed before the policy existed keeps running without it until it
  is redeployed (`deploy_on_change = false` means editing the file alone does
  not redeploy). Rerun the layer through the orchestrator (`bootstrap-global`
  for the vault, `bootstrap-env` for Postgres); data volumes stay; expect a
  short outage. After a reboot that already happened, start the stacks from the
  Dokploy UI or `docker start` on the host, vault database first.
- Verify with `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' <container>`.

**Decommissioning a previous setup.** Move the old root, its state, tfvars and
secret material unchanged into a git-ignored `.legacy/`. Destroy its live
resources only with explicit approval (`terraform plan -destroy` first, review,
then destroy; volumes may remain), then delete `.legacy/` by hand.

**Unverified code.** Keep a "Not verified yet" paragraph in the repo README
until a real `plan`/`apply` has passed on each layer; record Dokploy response
fields the API spec does not document (the orchestrator matches deployments by
their `description`/`title`).
