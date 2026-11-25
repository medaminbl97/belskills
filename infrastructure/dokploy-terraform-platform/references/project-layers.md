# Project layers

A **project** is a product or team (`<project>`, e.g. `shop`): its own vault
subtree, its own owned databases (if any), its own deployed apps, reusing every
shared platform service. This is the layer kind you stamp out repeatedly. Complete
fillable roots are in [`../templates/new-project/`](../templates/new-project/);
single-service fragments are in [`../templates/`](../templates/).

Component names below (`backend`, `frontend`) are stand-ins: use your real
ones. A "backend" is any service with its own datastore (API, CMS, ...). If it
is Directus, also follow the `directus-backend-bootstrap` skill for its internals.

## 1. `projects/<project>/secrets`

```hcl
variable "credential_version" { type = number, default = 1 }
variable "project" {}
locals {
  generated  = { "backend/DB_PASSWORD" = "backend", "backend/APP_SECRET" = "backend" }
  # Operator-supplied values (admin emails, OIDC client credentials if OIDC is enabled):
  configured = { "backend/ADMIN_EMAIL" = var.backend_admin_email }
}
resource "infisical_secret_folder" "project"   { folder_path = "/", name = var.project }
# Tokens for frontends and the CI runner are added MANUALLY in the vault; never generated.
resource "infisical_secret_folder" "component" { for_each = toset(["backend", "frontend", "runner"]), folder_path = infisical_secret_folder.project.path, name = each.key }
ephemeral "random_password" "generated" { for_each = local.generated, length = 48, special = false }
resource "infisical_secret" "generated"  { for_each = local.generated, folder_path = infisical_secret_folder.component[each.value].path, name = basename(each.key), value_wo = ephemeral.random_password.generated[each.key].result, value_wo_version = var.credential_version }
resource "infisical_secret" "configured" { for_each = toset(keys(local.configured)), folder_path = infisical_secret_folder.component[dirname(each.key)].path, name = basename(each.key), value = local.configured[each.key] }
output "folders" { value = { for name, folder in infisical_secret_folder.component : name => folder.path } }
```

Why some folders (`frontend`, `runner`) exist but get no generated secret: their
tokens come from a system that does not exist until the backend is deployed
(e.g. a read-only service-account token minted inside it), or from an external
system (GitHub). Terraform creates the empty folder so the path is stable and
documented; a human or later automation adds the value.

## 2. `projects/<project>/databases` [optional: only with shared Postgres]

```hcl
data "infisical_secrets" "postgres" { folder_path = "/platform/postgres" }
data "infisical_secrets" "backend"  { folder_path = "/${var.project}/backend" }
module "backend" {
  source         = "../../../modules/database"
  name           = "${var.platform}-${var.project}-${var.environment}-backend-database"
  environment_id = var.environment_id            # the PLATFORM postgres environment, injected by the orchestrator
  postgres_host  = var.postgres_host
  database       = "${replace(var.project, "-", "_")}_backend"
  user           = "${replace(var.project, "-", "_")}_backend"
  admin_password = data.infisical_secrets.postgres.secrets["POSTGRES_PASSWORD"].value
  password       = data.infisical_secrets.backend.secrets["DB_PASSWORD"].value
}
output "deployments" { value = [module.backend.deployment] }
output "containers"  { value = [module.backend.container] }
```

One `module` block, one vault data source and two concatenated output entries
per additional DB-backed component.

## 3. `projects/<project>/apps`

```hcl
locals {
  prefix     = "${var.platform}-${var.project}-${var.environment}"
  git_branch = var.environment == "dev" ? "dev" : "main"     # the ONLY place stage maps to branch
}
data "dokploy_github_provider" "apps" { name = var.github_app_name }   # an ALREADY-installed GitHub App; cannot create one
data "infisical_secrets" "component" { for_each = toset(["backend", "frontend", "runner"]), folder_path = "/${var.project}/${each.key}" }

resource "dokploy_application" "frontend" {
  name = "${local.prefix}-frontend"
  github = {
    owner        = split("/", trimsuffix(trimsuffix(var.frontend_repository_url, "/"), ".git"))[3]
    repository   = split("/", trimsuffix(trimsuffix(var.frontend_repository_url, "/"), ".git"))[4]
    branch       = local.git_branch
    github_id    = data.dokploy_github_provider.apps.id
    trigger_type = "push"
  }
  build       = { type = "dockerfile", dockerfile = "Dockerfile", context_path = "." }
  env         = "PORT=3000\nBACKEND_API_URL=https://${var.domains.backend}\nBACKEND_READ_TOKEN=${try(data.infisical_secrets.component["frontend"].secrets["API_TOKEN"].value, "")}"
  auto_deploy      = true
  deploy_on_change = false   # a Terraform-only change does NOT redeploy; only Git pushes (or the orchestrator) do
  lifecycle {
    precondition {
      condition     = try(trimspace(data.infisical_secrets.component["frontend"].secrets["API_TOKEN"].value) != "", false)
      error_message = "Add a read-only API_TOKEN to /${var.project}/frontend in the vault before deploying the frontend app."
    }
  }
}
resource "dokploy_domain" "frontend" { application_id = dokploy_application.frontend.id, host = var.domains.frontend, port = 3000, https = true, certificate_type = "letsencrypt" }
```

A `backend` sibling follows the same shape (built from source or a maintained
image via `docker = { image = ... }`, its own port, DB env from the vault,
CORS origins for the frontend domains). Add OIDC settings **only when the OIDC
layer is enabled**:

```hcl
env = <<-EOT
  ...
  %{ if var.oidc_url != "" ~}
  OIDC_ISSUER=${var.oidc_url}
  %{ endif ~}
EOT
```

Patterns that worked in a real project:

- **One repository, several apps**: a single `repository_url` variable; each app
  picks its own `build = { dockerfile, context_path }` (e.g. backend
  `directus/Dockerfile` with context `directus`, frontend `Dockerfile` with `.`).
  Set `app_name_prefix` so Swarm names are stable.
- **Private service URL**: the frontend gets
  `BACKEND_URL=http://${dokploy_application.backend.app_name}:<port>` and the
  token as a runtime env var, so the token never leaves `dokploy-network`;
  `build_args` carries only public values (e.g. the public API URL a bundler
  inlines).
- **One generated token, two consumers**: generate `backend/SERVICE_TOKEN` once;
  the backend applies it at startup and the frontend receives the same value.
- **Optional env lines**: build `env` with `join("\n", compact([...]))` and `""`
  for disabled entries instead of heredoc `%{ if }` blocks.
- **Conditional manual secrets**: a feature variable (e.g. `payment_provider`
  empty/`mock`/`stripe`) guards the manual vault values; a `lifecycle.precondition`
  names the exact vault path to fill before the apply can plan. Add a
  `precondition` that the shared Postgres host was injected.
- **Stage to behaviour**: derive branch (`dev`/`main`) and environment flags
  (e.g. `CMS_ENV`) from `var.environment` in one `locals` block; never hardcode.

`variables.tf` for this root declares: injected inputs (`dokploy_endpoint`,
`dokploy_api_key`, `infisical_*`, `platform`, `project`, `environment` validated
to `dev`/`prod`, `environment_id`, and `postgres_host` / `oidc_url` with
`default = ""` when optional), operator inputs (`domains`, repository URLs each
validated against `^https://github\.com/[^/]+/[^/]+/?$`, `github_app_name`), and
feature flags. `outputs.tf` concatenates every application into one
`deployments` list, leaves `containers` empty unless Compose jobs exist, and lists
one `checks` entry per public service (a **real** health path).

**Runtime secret rule for every app in every project:** inject read-only,
server-only secrets as plain environment variables consumed by server code only.
Never as client-bundled/`VITE_`-prefixed/build-time variables, never baked into
the image, never logged. If a build step needs a secret, fix the application.

## 4. Optional self-hosted CI runner (`apps` → `runner.tf`)

```hcl
resource "dokploy_application" "runner" {
  count  = var.enable_github_runner ? 1 : 0
  docker = { image = "myoung34/github-runner:latest" }   # pin a version
  env = <<-EOT
    RUNNER_SCOPE=org
    ORG_NAME=${var.github_runner_org}
    RUNNER_TOKEN=${try(data.infisical_secrets.component["runner"].secrets["RUNNER_TOKEN"].value, "")}
  EOT
  lifecycle { precondition { condition = var.github_runner_org != "" && contains(keys(data.infisical_secrets.component["runner"].secrets), "RUNNER_TOKEN"), error_message = "Set github_runner_org and add RUNNER_TOKEN before enabling the runner." } }
}
resource "dokploy_mount" "runner_socket" { count = var.enable_github_runner ? 1 : 0, type = "bind", host_path = "/var/run/docker.sock", mount_path = "/var/run/docker.sock" }
```

Mounting the host Docker socket is equivalent to root on the host. Keep it
opt-in, justify it per project, and say so in the project's docs.

## 5. Add a new project end-to-end

1. Add its lowercase slug to the **persistent** `consumer_projects` set in
   `bootstrap/projects/terraform.tfvars` (extend it, do not replace it); review
   and apply that root alone.
2. Create `terraform/projects/<new>/{secrets,databases,apps}` from
   [`../templates/new-project/`](../templates/new-project/): complete, fillable
   roots. Rename every placeholder, decide which components need a database
   (drop `databases` entirely if none or if the platform has no Postgres), wire
   real repository URLs, domains and ports.
3. Copy and fill every `<env>.tfvars.example` per stage; real values never go in
   `.example` files.
4. If OIDC is enabled, create the project's per-stage OIDC clients in the
   provider; add app tokens after the first-install ordering in
   [operations.md](operations.md).
5. `make full ENV=dev PROJECTS="<new>"`, review every plan, then repeat for `prod`.

## 6. Add one service to an existing project

Use the four fragments in [`../templates/`](../templates/) (`secrets.tf.example`,
`database.tf.example`, `application.tf.example`, `dev.tfvars.example`):

1. **Secrets** (generated credentials needed): add to `generated`/`configured`
   locals and the `component` folder `for_each` set.
2. **Database** (DB-backed, Postgres enabled): vault data source for its folder
   + one `module` call in `databases`; append `deployment`/`container` to outputs.
3. **Application**: a `dokploy_application` + `dokploy_domain` pair (or extend a
   `for_each` map), own port and real health path; append to `deployments` and
   `checks`.
4. New variables in `variables.tf` (repo URL with the HTTPS-GitHub regex, domain,
   flags); fill every per-stage tfvars.
5. `make validate PROJECT=<project>`, then `make plan STACK=apps ENV=dev
   PROJECT=<project>` (and `secrets`/`databases` if touched), review, then
   `make project-apps` (or `project-deploy` if secrets/databases changed).
