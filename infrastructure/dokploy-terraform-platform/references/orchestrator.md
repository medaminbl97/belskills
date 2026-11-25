# The orchestration contract

Read before writing or modifying any root: it defines the shape every layer
must produce and consume. The orchestrator (`scripts/stack.py` in the
reference implementation) is **not bundled with this skill**. Copy it from a
repo that has it, or implement exactly this contract, with unit tests.

## 1. The `STACKS` map and optional features

```python
STACKS = {
    "projects": "bootstrap/projects",
    "infisical": "bootstrap/infisical/service",
    "infisical-project": "bootstrap/infisical/project",
    "platform-secrets": "bootstrap/secrets",
    "postgres": "bootstrap/postgres",                 # optional
    "oidc-database": "bootstrap/oidc/database",       # optional (needs postgres)
    "oidc": "bootstrap/oidc/service",                 # optional
    "secrets": "projects/{project}/secrets",
    "databases": "projects/{project}/databases",      # optional (needs postgres)
    "apps": "projects/{project}/apps",
}
GLOBAL = {"projects", "infisical", "infisical-project"}  # one state only, stage ignored
FEATURES = {"postgres": True, "oidc": False}             # from config; see below
```

- `FEATURES` comes from one place (e.g. `.env` `ENABLE_POSTGRES`/`ENABLE_OIDC`,
  or a config file). Reject inconsistent combinations at startup
  (`oidc` requires `postgres` when the provider uses it as its database).
- Disabled features are removed from the stack list, from `inputs()`, from the
  destroy-guard map and from Make targets; no layer may depend on a disabled one.
- A new **project** reuses `secrets`/`databases`/`apps` (templated with
  `{project}`): no orchestrator change. A new **layer kind** needs an entry here,
  a branch in `inputs()`, an entry in the destroy guard's `downstream` map, Make
  registration and test updates: a deliberate, larger change.

## 2. Dependency resolution (`Stack.inputs()`)

Each layer calls `self.dependency("<other-stack>")`, which instantiates that
stack, reads its **non-sensitive** outputs and raises unless its `.deployed`
marker exists for the stage. Resolution chain:

| Layer | Depends on | Receives |
| --- | --- | --- |
| `projects` | n/a | `dokploy_endpoint`, `dokploy_api_key`, `platform` |
| `infisical` | `projects` | `environment_id` = `projects.secrets.environments.prod` (vault runs in prod only) |
| `infisical-project` | `infisical` | `infisical_url` |
| `platform-secrets` | `infisical-project` | `infisical_url`, `environment`, `infisical_project_id`, `platform` |
| `postgres` *(opt.)* | `platform-secrets` | same + `environment_id` = `projects.postgres.environments[stage]` |
| `oidc-database` *(opt.)* | `postgres` | + `postgres_host` |
| `oidc` *(opt.)* | `oidc-database` | + `environment_id` = `projects.oidc.environments[stage]` |
| `secrets` (project) | `platform-secrets` | `infisical_url`, `environment`, `infisical_project_id`, `platform`, `project` |
| `databases` (project, *opt.*) | `secrets`, `postgres` | + `environment_id` = **platform postgres** environment for the stage, `postgres_host` |
| `apps` (project) | `secrets`, plus `databases` if enabled, plus `oidc` if enabled | + `environment_id` = `projects.<project>.environments[stage]`, `postgres_host` only if enabled, `oidc_url` only if enabled |

Every layer except `projects` also needs `INFISICAL_TOKEN`; refuse to proceed
without it. When `oidc`/`postgres` are disabled, **do not pass empty values**:
omit the input so Terraform uses the variable's default (`""`), and let roots
guard usage with `var.oidc_url != ""`. Skipping a dependency lets a layer apply
against a half-initialized platform; mirror this table when adding a layer kind.

## 3. Output contract every root exposes

```hcl
output "deployments" {           # Dokploy resources to (re)deploy on apply
  value = [{ kind = "application", id = dokploy_application.x.id }]   # or kind = "compose"
}
output "containers" {            # containers the orchestrator waits on directly (SSH + docker)
  value = [{ project = dokploy_compose.x.app_name, service = "db", mode = "healthy" }]
  # "healthy"   -> Docker healthcheck reports healthy (long-running services)
  # "completed" -> a freshly started container exits 0 (one-shot jobs)
}
output "checks" {                 # HTTP checks after deployment/containers are ready
  value = [{ url = "https://host/health", discovery = false }]
  # discovery = true adds OIDC discovery validation; also set `issuer`
}
# Plus any value another layer's inputs() needs (ids, urls, hostnames).
# Secrets a layer owns must be `sensitive = true`; outputs() filters them out.
```

For `mode = "completed"` the orchestrator records each container's `StartedAt`
before requesting a fresh deployment, then waits for a **newly started**
container (different `StartedAt`) to reach `exited` with `ExitCode == 0`. An old
successful run never satisfies it.

## 4. Apply, deployment and readiness sequence

For `apply`/`destroy`: `init` → `plan -detailed-exitcode -out=plan` into a
private temp dir → `terraform show -json` to detect whether any *managed*
resource really changes → if so and `-auto-approve` was not explicitly given,
prompt `Type yes to apply ...` → delete any stale `.deployed` marker → apply the
saved plan. On success, re-read outputs and decide whether to force a redeploy
(`changed` OR first apply OR the layer is not in the narrow allow-list that is
left alone when unchanged, e.g. the vault and Postgres), then:

1. For each `deployments` entry, queue it through the Dokploy API
   (`application.deploy` / `compose.deploy`) with a **unique description**
   (`<platform>-stack:<uuid>`), first recording the Swarm service's *current*
   running task IDs to tell old tasks from new ones.
2. Poll that deployment's history filtered by the exact description until
   `done` (raise on `error`/`failed`/`cancelled`); more than one match is an
   error (ambiguous correlation).
3. For applications, poll `docker service inspect` until `UpdateStatus` is not
   paused/rolled back, the task count matches the replica count and **every**
   running task ID is new. This fixes the race where an old healthy container
   answers a health check while the real rollout is in flight.
4. Wait for each `containers` entry per `healthy`/`completed`.
5. Poll each `checks` URL, tolerating `404/429/500/502/503/504` as "not ready
   yet". For `discovery: true`, parse the body as OIDC discovery JSON and assert
   `issuer`/`authorization_endpoint`/`token_endpoint`/`jwks_uri` exist and the
   issuer matches exactly.
6. Only then `touch` the `.deployed` marker for that root+stage.

Five-minute timeouts; a timeout does **not** cancel the Dokploy job, so
inspect its protected deployment/log history before retrying. The destroy guard
refuses `destroy` while any *downstream* layer's state still has resources, so
destruction goes `apps` → `databases` → `secrets` → … one explicit `STACK=` at
a time.

## 4b. Details a working implementation settled on

Reference size: about 830 lines of stdlib Python plus 47 unit tests (no
infrastructure needed, `make test`). Worth copying as behaviour:

- **SSH is optional** (`DOKPLOY_SSH`). Without it, `Rollout` drops `containers`
  and the Swarm-task check, prints a warning, and relies on the Dokploy
  deployment status plus HTTP checks. With it, preflight also runs `docker
  version` on the host. Keep both paths tested.
- **Unsupported features fail loudly**: `ENABLE_OIDC=true` raises a `StackError`
  when there is no OIDC layer; a `discovery: true` check is refused likewise.
  Never accept a flag and ignore it.
- **Config validation**: `PLATFORM_NAME` must match `^[a-z][a-z0-9-]{0,15}$`; feature
  values tolerate quotes (`"true"`); missing variables are named in the error.
- **Safety**: `-target` rejected in every code path; `TF_APPLY_ARGS` accepts only
  `-auto-approve`; HTTP errors never leak response bodies; no shared
  `TF_PLUGIN_CACHE_DIR` reaches Terraform; stage tfvars passed only if present.
- **Preflight**: Terraform >= 1.11 (write-only secrets), `https://` endpoint,
  Dokploy key accepted, optional `docker version` over SSH.
- **Extra commands**: `validate` (init `-backend=false` plus validate for every
  active root), `output` (non-sensitive outputs of one layer, e.g. a webhook URL
  to register elsewhere), `steps` (Make target printing the install and
  everyday flow), `test`.
- **Redeploy rule**: a layer is redeployed on every apply (apps pull the
  branch's latest code, the idempotent database job re-runs) except those in
  `LEAVE_ALONE_WHEN_UNCHANGED` (vault, Postgres) when the plan changed nothing
  and it is not the first apply.
- **Make**: retired knobs (`SERVICES`, `DEPLOYMENT_STAGE`, `TARGET`) are an
  `$(error)`; `destroy` refuses `ENV=all`; Make reads the Postgres feature
  from the orchestrator's `Config`, so the flag lives in one place.

## 5. Make layering

```text
make full ENV=dev PROJECTS="shop"        # bootstrap-global, then per stage: bootstrap-env + project-deploy
  make bootstrap-global                  # preflight, projects, infisical, infisical-bootstrap, infisical-project
  make bootstrap-env ENV=dev             # platform-secrets [+ postgres, + oidc-database/oidc if enabled]
  make project-deploy ENV=dev PROJECTS=... # per project: project-secrets, [project-databases], project-apps
```

`ENV=all` runs `dev` then `prod` as two independent loops (global layers once).
`PROJECT`/`PROJECTS` pick **already-registered** projects; they never add or
remove one from topology (that is `consumer_projects`). Reject retired knobs
(`SERVICES=`, `DEPLOYMENT_STAGE=`); do not reintroduce partial/targeted deploys.
