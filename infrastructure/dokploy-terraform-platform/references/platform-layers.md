# Platform (bootstrap) layers

These roots exist once per platform. Code is the real pattern, trimmed where
noted; `${var.platform}` is the name prefix injected by the orchestrator.
Sections 4 and 6 (Postgres, DB module) are **optional**, section 7 (OIDC) too.

## 1. Topology (`bootstrap/projects`)

```hcl
variable "platform" { type = string }
variable "consumer_projects" {
  type    = set(string)
  default = []                    # EVERY product, not just this run's selection
  validation {
    condition = alltrue([
      for name in var.consumer_projects :
      can(regex("^[a-z][a-z0-9-]*$", name)) && length(name) <= 32 && !contains(["secrets", "oidc", "postgres"], name)
    ])
    error_message = "Consumer names must be lowercase slugs, excluding secrets, oidc and postgres."
  }
}
locals {
  # Reserved projects: drop "postgres" / "oidc" when those features are disabled.
  platform_projects = toset(["secrets", "postgres", "oidc"])
}
resource "dokploy_project" "project" {
  for_each    = setunion(local.platform_projects, var.consumer_projects)
  name        = "${var.platform}-${each.key}"
  description = "${var.platform} ${each.key}, managed by the platform topology"
}
resource "dokploy_environment" "dev" {
  for_each   = dokploy_project.project
  project_id = each.value.id
  name       = "dev"
}
output "projects" {
  value = {
    for name, project in dokploy_project.project : name => {
      id           = project.id
      environments = { dev = dokploy_environment.dev[name].id, prod = project.production_environment_id }
    }
  }
}
```

`prod` is Dokploy's own built-in environment (cannot be renamed), referenced via
`production_environment_id`. Never create a second "prod".

## 2. Secrets vault, self-contained (`bootstrap/infisical/service`)

The vault cannot read its own future secrets: it generates its Postgres/Redis
passwords with `random_bytes`/`random_password`, passes them as the Compose
stack's `env`, and never re-reads them from itself.

```hcl
resource "random_bytes" "encryption_key" { length = 16 }   # losing this makes the vault unreadable
resource "random_bytes" "auth_secret"    { length = 32 }
resource "random_password" "service" {
  for_each = toset(["database", "redis"])
  length   = 48
  special  = false
}
resource "dokploy_compose" "infisical" {
  name           = "${var.platform}-infisical"
  environment_id = var.environment_id        # the "secrets" project, prod environment
  delete_volumes   = false                   # never delete the vault's data with the layer
  deploy_on_change = false                   # the orchestrator decides when to redeploy
  env = <<-EOT
    ENCRYPTION_KEY=${random_bytes.encryption_key.hex}
    AUTH_SECRET=${random_bytes.auth_secret.base64}
    POSTGRES_PASSWORD=${random_password.service["database"].result}
    REDIS_PASSWORD=${random_password.service["redis"].result}
  EOT
  raw = { compose_file = <<-YAML
    services:
      infisical:
        image: infisical/infisical:v0.167.14      # pin; review before upgrading
        restart: always                           # depends_on does not order reboot restarts; this retries until the DB answers
        depends_on: { infisical-db: {condition: service_healthy}, infisical-redis: {condition: service_healthy} }
        environment:
          SITE_URL: https://${var.infisical_domain}
          ENCRYPTION_KEY: $${ENCRYPTION_KEY:?required}
          AUTH_SECRET: $${AUTH_SECRET:?required}
          DB_CONNECTION_URI: postgres://infisical:$${POSTGRES_PASSWORD:?required}@infisical-db:5432/infisical
          REDIS_URL: redis://:$${REDIS_PASSWORD:?required}@infisical-redis:6379
        networks: [default, dokploy-network]
      infisical-db:
        image: postgres:16-alpine
        restart: always
        environment: { POSTGRES_USER: infisical, POSTGRES_DB: infisical, POSTGRES_PASSWORD: "$${POSTGRES_PASSWORD:?required}" }
        volumes: ["database:/var/lib/postgresql/data"]
        healthcheck: { test: ["CMD", "pg_isready", "-U", "infisical", "-d", "infisical"], interval: 5s, retries: 24 }
      infisical-redis:
        image: redis:7-alpine
        restart: always
        command: ["redis-server", "--appendonly", "yes", "--requirepass", "$${REDIS_PASSWORD:?required}"]
        volumes: ["redis:/data"]
        # authenticate: with requirepass a bare `redis-cli ping` is not a real health signal
        healthcheck: { test: ["CMD", "redis-cli", "-a", "$${REDIS_PASSWORD:?required}", "ping"], interval: 5s, retries: 24 }
    volumes: { database: {name: "${var.platform}-infisical-database"}, redis: {name: "${var.platform}-infisical-redis"} }
    networks: { dokploy-network: { external: true } }
    YAML
  }
}
resource "dokploy_domain" "infisical" {
  compose_id = dokploy_compose.infisical.id
  service_name = "infisical"
  host = var.infisical_domain
  port = 8080
  https = true
  certificate_type = "letsencrypt"
}
output "deployments" { value = [{ kind = "compose", id = dokploy_compose.infisical.id }] }
output "containers"  { value = [{ project = dokploy_compose.infisical.app_name, service = "infisical-db", mode = "healthy" }] }
output "checks"      { value = [{ url = "https://${var.infisical_domain}/api/status" }] }
output "recovery"    { sensitive = true, value = { ENCRYPTION_KEY = random_bytes.encryption_key.hex, AUTH_SECRET = random_bytes.auth_secret.base64 } }
```

`recovery` is `sensitive` so `outputs()` never returns it to another layer; only
an explicit `make infisical-recovery` reads it.

## 3. First-admin bootstrap (operator step, not Terraform)

Terraform cannot create the vault's first organization/admin. A
`stack.py infisical-bootstrap` command polls `GET /api/v1/admin/config` for
`initialized`; if false it interactively prompts for admin email, org and
password (14+ chars, confirmed), calls `POST /api/v1/admin/bootstrap`, and
writes the returned **non-expiring instance-admin token** to `.env` as
`INFISICAL_TOKEN` (mode 0600). If already initialized but the token was lost,
sign in and mint a new one for the instance admin identity (Server Console →
Machine Identities). Bootstrap cannot run twice.

## 4. The vault project (`bootstrap/infisical/project`)

```hcl
resource "infisical_project" "platform" {
  name = var.platform_title, slug = "${var.platform}-platform"
  should_create_default_envs = false      # define exactly dev/prod ourselves
  has_delete_protection      = true
}
resource "infisical_project_environment" "environment" {
  for_each   = { dev = "Development", prod = "Production" }
  project_id = infisical_project.platform.id
  slug       = each.key
  name       = each.value
}
output "project_id" { value = infisical_project.platform.id }
```

## 5. Platform-wide generated secrets (`bootstrap/secrets`)

Generate with `ephemeral` + `value_wo`/`value_wo_version`, so a manual edit in
the vault survives re-apply until `credential_version` is bumped:

```hcl
variable "credential_version" { type = number, default = 1 }
locals {
  # Keep only the components that exist. postgres/ and oidc/ are OPTIONAL.
  generated = { "postgres/POSTGRES_PASSWORD" = "postgres", "oidc/DB_PASSWORD" = "oidc", "oidc/ENCRYPTION_KEY" = "oidc" }
  components = toset(["postgres", "oidc"])
}
resource "infisical_secret_folder" "platform"  { folder_path = "/", name = "platform" }
resource "infisical_secret_folder" "component" { for_each = local.components, folder_path = infisical_secret_folder.platform.path, name = each.key }
ephemeral "random_password" "generated" { for_each = local.generated, length = 48, special = false }
resource "infisical_secret" "generated" {
  for_each         = local.generated
  folder_path      = infisical_secret_folder.component[each.value].path
  name             = basename(each.key)
  value_wo         = ephemeral.random_password.generated[each.key].result
  value_wo_version = var.credential_version
}
# Configured (operator-supplied) values use plain `value`, e.g. the OIDC admin email:
resource "infisical_secret" "oidc_admin_email" { folder_path = infisical_secret_folder.component["oidc"].path, name = "INITIAL_ADMIN_EMAIL", value = var.oidc_admin_email }
```

The distinction used everywhere: **generated** = `value_wo` + `credential_version`;
**configured** = ordinary `value`, re-applied from tfvars on every run.

## 6. Shared PostgreSQL server (`bootstrap/postgres`) [optional]

One Compose stack per stage running only the server; no databases are created
here.

```hcl
variable "postgres_image" { type = string, default = "postgres:17.6-alpine" }   # pin the minor; keep modules/database's `image` in line
data "infisical_secrets" "postgres" { folder_path = "/platform/postgres" }
resource "dokploy_compose" "postgres" {
  name = "${var.platform}-postgres-${var.environment}"
  environment_id   = var.environment_id
  delete_volumes   = false          # removing data is a separate, human-approved procedure
  deploy_on_change = false
  env  = "POSTGRES_PASSWORD=${data.infisical_secrets.postgres.secrets["POSTGRES_PASSWORD"].value}"
  raw = { compose_file = <<-YAML
    services:
      ${var.platform}-postgres-${var.environment}:
        image: ${var.postgres_image}
        restart: always
        environment: { POSTGRES_USER: postgres, POSTGRES_DB: postgres, POSTGRES_PASSWORD: "$${POSTGRES_PASSWORD:?required}" }
        volumes: ["data:/var/lib/postgresql/data"]
        networks: [dokploy-network]
        healthcheck: { test: ["CMD", "pg_isready", "-U", "postgres", "-d", "postgres"], interval: 5s, retries: 24 }
    volumes: { data: { name: ${var.platform}-postgres-${var.environment}-data } }
    networks: { dokploy-network: { external: true } }
    YAML
  }
}
output "host" { value = "${var.platform}-postgres-${var.environment}" }   # Compose service name = DNS name
```

Port 5432 is never published to the host; consumers use the service name over
`dokploy-network`.

## 7. Reusable database module (`modules/database`) [optional, needs Postgres]

Reused by every DB-backed component in every project. Call it; never duplicate.

```hcl
variable "name" {}            # unique job name: <platform>-<project>-<stage>-<component>-database
variable "environment_id" {}  # the environment the JOB runs in (platform postgres env, not the consumer's)
variable "postgres_host" {}
variable "database" {}        # "<project>_<component>" (replace "-" with "_")
variable "user" {}            # same convention; role name == database name
variable "admin_password" { sensitive = true }   # shared Postgres superuser password
variable "password"       { sensitive = true }   # this component's role password
resource "dokploy_compose" "provision" {
  name = var.name
  create_env_file = true
  env  = "PGPASSWORD=${var.admin_password}\nDB_PASSWORD=${var.password}"
  raw = { compose_file = yamlencode({
    services = { provision = {
      image   = var.image   # variable "image", default the same pinned postgres as the server
      command = ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-f", "/provision.sql"]
      environment = { PGHOST = var.postgres_host, PGPORT = "5432", PGUSER = "postgres", PGDATABASE = "postgres",
                       PGPASSWORD = "$${PGPASSWORD:?required}", DB_PASSWORD = "$${DB_PASSWORD:?required}",
                       DB_NAME = var.database, DB_USER = var.user }
      configs  = [{ source = "provision", target = "/provision.sql" }]
      networks = ["dokploy-network"]
      restart  = "no"   # one-shot job: it must NOT run again after a reboot (the opposite of the servers)
    } }
    configs  = { provision = { content = file("${path.module}/provision.sql") } }
    networks = { dokploy-network = { external = true } }
  }) }
}
output "deployment" { value = { kind = "compose", id = dokploy_compose.provision.id } }
output "container"  { value = { project = dokploy_compose.provision.app_name, service = "provision", mode = "completed" } }
```

```sql
-- modules/database/provision.sql: idempotent, safe to rerun on every apply
\getenv database DB_NAME
\getenv username DB_USER
\getenv password DB_PASSWORD
SELECT format('CREATE ROLE %I LOGIN', :'username')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'username') \gexec
ALTER ROLE :"username" WITH LOGIN PASSWORD :'password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
SELECT format('CREATE DATABASE %I OWNER %I', :'database', :'username')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'database') \gexec
ALTER DATABASE :"database" OWNER TO :"username";
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
```

Runs once per `databases` apply, always in the **platform postgres
environment**; creates role/database only if missing, otherwise updates
password and ownership, always revokes `PUBLIC`. It never drops data: deleting a
component's database is a separate, human-approved procedure.

## 8. OIDC provider [optional]

Enable only when apps need SSO or OIDC token validation. The layer is a slot:
any provider with a standard discovery document works. Pocket ID is the worked
example; for Keycloak/Authentik change the image, port, env and discovery path.

- **`bootstrap/oidc/database`** (only if the provider uses shared Postgres):
  one `modules/database` call (`database = user = "pocket_id"`) in the
  `postgres` project's environment. Providers with embedded storage (SQLite) skip
  this layer and `oidc` depends directly on `platform-secrets`; update the
  dependency table accordingly.
- **`bootstrap/oidc/service`**: a plain Dokploy application on the upstream
  image, with the DB URL, encryption key and bootstrap admin email injected
  from the vault:

```hcl
resource "dokploy_application" "oidc" {
  name   = "${var.platform}-oidc-${var.environment}"
  docker = { image = var.oidc_image }   # pin a version; avoid :latest in prod
  env = <<-EOT
    TRUST_PROXY=true
    DB_PROVIDER=postgres
    DB_CONNECTION_STRING=postgres://pocket_id:${urlencode(local.oidc["DB_PASSWORD"].value)}@${var.postgres_host}:5432/pocket_id
    ENCRYPTION_KEY=${local.oidc["ENCRYPTION_KEY"].value}
    INITIAL_ADMIN_EMAIL=${local.oidc["INITIAL_ADMIN_EMAIL"].value}
    APP_URL=https://${var.oidc_domain}
  EOT
}
resource "dokploy_mount" "oidc_data" { service_type = "application", type = "volume", volume_name = "${var.platform}-oidc-${var.environment}-data", mount_path = "/app/data" }
resource "dokploy_domain" "oidc" { host = var.oidc_domain, port = 1411, https = true, certificate_type = "letsencrypt" }
output "oidc_url" { value = "https://${var.oidc_domain}" }   # consumed by project apps roots
output "checks"   { value = [{ url = "https://${var.oidc_domain}/.well-known/openid-configuration", discovery = true, issuer = "https://${var.oidc_domain}" }] }
```

Per project, the OIDC clients (redirect URIs, client ID/secret) are created
**manually** in the provider's UI per stage and stored as *configured* secrets
in that project's secrets root.

When OIDC is **disabled**: delete the `oidc` project from topology's reserved
set, the `oidc/*` secrets, the `oidc-database`/`oidc` stacks, the `oidc_url`
input, and any app env lines that use it.
