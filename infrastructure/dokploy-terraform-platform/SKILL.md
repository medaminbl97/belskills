---
name: dokploy-terraform-platform
description: Design, bootstrap, extend or troubleshoot a layered self-hosted platform on one Docker host, using Dokploy and Terraform with Infisical for secrets, an optional shared PostgreSQL, an optional OIDC provider, and any number of isolated projects (products), each with its own secrets, databases and deployed apps. Use for adding a project or service, wiring secrets or databases, the apply and readiness orchestration, and for reproducing the architecture in a new repo. Written to stand on its own.
---

# Dokploy + Terraform layered platform

A blueprint for one Docker host (Dokploy: Swarm apps, Compose for stateful
pieces, Traefik TLS) managed as **independent Terraform layers**, driven by a
thin orchestrator that applies layers in dependency order and waits for real
readiness. Detailed enough to rebuild in a new repo or extend an existing one.

**Never apply, deploy, destroy, rotate credentials or install dependencies
without explicit approval.** Default to producing configuration, a plan and a
clear statement of what an apply would do. No Terraform or Docker was run when
this skill was written: treat all code as verified *patterns* to adapt, and
validate with `terraform validate` / `plan` before trusting them.

If the repo already has the live implementation (README, orchestrator script,
Make targets, Terraform roots), read it first: this document can drift from it.

## Naming used here

| Placeholder | Meaning |
| --- | --- |
| `<platform>` | Short slug prefixing every resource name (e.g. `acme`). Injected into every root as `var.platform`; never hardcode it. |
| `<project>` | A product/team slug (e.g. `shop`) that owns secrets, databases and apps. |
| stage | `dev` or `prod`; separate state, separate secrets, separate hostnames. |

## What is required and what is optional

| Piece | Status | Notes |
| --- | --- | --- |
| Topology (Dokploy projects/environments) | required | one root, owns the list of projects |
| Secrets vault (Infisical, self-contained) | required | single source of truth for credentials |
| Platform secrets root | required | generated platform-wide secrets per stage |
| Shared PostgreSQL + `modules/database` | **optional** | only if any component needs a relational DB |
| OIDC provider (e.g. Pocket ID, Keycloak, Authentik) | **optional** | only if apps need SSO or token validation |
| Project layers: `secrets`, `apps` | required per project | |
| Project layer: `databases` | optional | exists only when the shared PostgreSQL does |
| Self-hosted CI runner | optional | opt-in per project; mounts the Docker socket (host root) |

Decide each optional piece up front (ask the user if unclear) and record it in
the orchestrator config (`FEATURES = {"postgres": bool, "oidc": bool}`). A
disabled feature means: its STACKS entries are skipped, its table rows in the
dependency list are dropped, the downstream layers do not receive its inputs
(`postgres_host`, `oidc_url`), and templates delete the matching variables and
blocks. Never leave dead references to a disabled layer. OIDC in particular is
a **slot, not a product**: any provider with a standard discovery document
fits; Pocket ID is only the worked example.

## Architecture

```text
 One Docker host (Dokploy): Swarm services + Compose, Traefik TLS
 Dokploy projects (topology, created once):
   <platform>-secrets (prod only)  <platform>-postgres (opt.)  <platform>-oidc (opt.)
   Infisical + own Postgres/Redis   one PostgreSQL per stage     OIDC provider per stage
            ▲                              ▲                          ▲
            │ read secrets                 │ provision DB/role        │ validate
   <platform>-<project>   (one per product)
     secrets   Infisical folders per component (generated + configured + manual)
     databases one owned Postgres role+DB per DB-backed component (optional)
     apps      Dokploy applications (Git source, Dockerfile build) + image services
```

Properties to preserve when rebuilding:

- **One shared host**; Swarm apps for long-running services, Compose for stateful
  infra and one-shot jobs; everything joins external network `dokploy-network`.
  Not Kubernetes, not multi-host, no service mesh without a real scaling need.
- **Topology is data.** One `bootstrap/projects` root owns the project list and
  exposes IDs as outputs; no other root hardcodes IDs.
- **Shared platform, isolated product data.** Isolation is by credential and
  folder/database, not by separate servers. Products never get superuser access.
- **No circular bootstrap.** The vault carries its own Postgres/Redis and its own
  locally generated secrets; it does not store them in itself.
- **Independent Terraform state per layer per stage.** Small, reviewable plans;
  applying one layer cannot touch another's resources.
- **A thin orchestrator, not Terragrunt/Terraform Cloud.** It resolves inputs
  from dependency outputs, plans, asks for confirmation, applies, then actively
  waits for real deployment and runs checks. A `.deployed` marker per
  root+stage is the contract between layers.
- **One source of truth for secrets** (Infisical); apps receive values injected
  at apply time, never hand-managed in the Dokploy UI.

## Repository layout contract

```text
terraform/
  bootstrap/
    projects/              topology: Dokploy projects + dev/prod environments
    infisical/service/     vault + own Postgres/Redis (one, in secrets/prod)
    infisical/project/     vault project + dev/prod environments
    secrets/               platform-wide generated secrets, per stage
    postgres/              [optional] shared PostgreSQL, per stage
    oidc/database/         [optional, needs postgres] OIDC provider's DB
    oidc/service/          [optional] OIDC provider app + domain + volume
  modules/database/        [optional] reusable "create DB role + database" job
  projects/<project>/
    secrets/  databases/ [optional]  apps/
scripts/stack.py, test_stack.py      orchestrator + its tests
make/*.mk, Makefile                  ENV/PROJECT/PROJECTS, init/plan/apply/destroy
.env(.example)                       DOKPLOY_ENDPOINT, DOKPLOY_API_KEY, DOKPLOY_SSH,
                                     INFISICAL_TOKEN, PLATFORM_NAME
.state/                              git-ignored: states/, data/ (TF_DATA_DIR), providers/
```

Each root is a complete configuration (`backend "local" {}`); the orchestrator
points it at `.state/states/<path>/<stage>.tfstate` and a private `TF_DATA_DIR`.

## Where to read next

Load only what the task needs:

| Task | Read |
| --- | --- |
| Writing or changing the orchestrator, `STACKS`, outputs contract, readiness | [references/orchestrator.md](references/orchestrator.md) |
| Bootstrapping platform layers (topology, vault, secrets, Postgres, DB module, OIDC) | [references/platform-layers.md](references/platform-layers.md) |
| Project layers (secrets, databases, apps, runner), new project, new service | [references/project-layers.md](references/project-layers.md) |
| First install order, secrets/state/recovery, validation, troubleshooting, destroy | [references/operations.md](references/operations.md) |
| Starting files | [templates/](templates/): fragments for one new service; `new-project/` for complete project roots |

Every template is deliberately non-deployable until placeholders
(`SERVICE_SLUG`, `<project>`, repository URLs, domains, ports) are replaced.

## Rules that always apply

1. Layers apply in dependency order; a layer refuses to run without its
   prerequisites' `.deployed` markers. Never `-target`; never partial deploys.
2. Naming comes from `var.platform`, `var.project`, `var.environment`.
3. **Generated** secrets use `ephemeral` + `value_wo`/`value_wo_version`
   (manual edits survive; bump `credential_version` to regenerate). **Configured**
   secrets come from tfvars and are always re-applied. **Manual** secrets
   (tokens minted by a deployed system, CI tokens): Terraform only creates the
   empty folder.
4. Server-only secrets are runtime environment variables of server code; never
   client-bundled, build-time, baked into an image or logged.
5. Real values go in untracked `*.tfvars` and `.env`, never in `.example` files
   or Git. State and Dokploy both hold injected secrets: treat both as sensitive.
6. Destroy only in reverse dependency order, one layer at a time; volumes
   survive a destroy; deleting data is a separate human-approved procedure.
7. Add a project by extending `consumer_projects` (never replace it) and
   copying `templates/new-project/`; add a layer *kind* only deliberately, and
   update the orchestrator, its tests, the destroy-guard map and Make targets.
8. Do not disable TLS verification. Do not publish database ports.
