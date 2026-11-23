---
name: directus-backend-bootstrap
description: Use whenever a repo needs a Directus backend or changes to one (collections, fields, relations, translations, seeds, access policies, startup, CI). Defines our standard Docker + Postgres flow with YAML schemas synced at startup, environment-aware seeds, managed read-only policies and a smoke test, and ships ready-to-copy templates so every repo works the same way.
---

# Directus backend: our standard flow

Every repo with a Directus backend uses **the same flow and the same files**.
Do not invent a new layout. For a new backend, copy `templates/` (next to this
file) and adapt it. For an existing backend, compare it with `templates/` and
converge on it, asking before any destructive change.

The flow is proven in the `izr-cms` repo. The templates are the generic version
of its scripts, with project-specific names removed.

## The flow in one paragraph

Collections are declared as YAML in `schemas/<domain>/`. On every container
start the entrypoint runs Directus `bootstrap`, starts a **temporary private
server** on `127.0.0.1:8056`, runs `scripts/apply-schemas.js` (schema sync,
then seeds, then access policies), stops the temporary server, and only then
starts the public one. If anything fails the container exits nonzero and never
serves. Changing YAML means rebuilding the image (`make up`).

## Standard layout

```text
Dockerfile              pinned directus/directus image + loader baked in
compose.yaml            postgres + directus, volumes: database, uploads, schema-state
entrypoint.sh           bootstrap -> temp server -> apply-schemas -> public server
Makefile                up | down | restart | reseed | logs
package.json, package-lock.json   only js-yaml (loader dependency)
.env.example            documented variables; .env is never committed
schemas/<domain>/*.yaml one collection per file
seeds/<domain>/*.yaml   one seed file per collection
policies/apps.yaml      managed read-only policies + keyless service users
scripts/apply-schemas.js   validate YAML, sync schema, then seed + policies
scripts/seed-data.js       environment-aware, idempotent seeding
scripts/apply-policies.js  policy/permission/service-user reconciliation
scripts/*.test.js          unit tests (node --test scripts/*.test.js)
scripts/smoke-test.sh      integration check against the running stack
.github/workflows/smoke-test.yml   PR gate: unit tests + docker smoke test
AGENTS.md / README.md   document the behavior below (see "Document it")
```

## Setting up a new repo

1. Copy `templates/` into the repo root, **including dotfiles** (`.env.example`,
   `.dockerignore`, `.gitignore`, `.github/`). Merge with, never overwrite,
   existing files. Put the lockfile in place; run `npm install` to refresh it.
2. Delete the example `schemas/content/articles*.yaml` and
   `seeds/content/articles.yaml` once real collections exist. Keep
   `languages.yaml` only if the project is multilingual; edit its codes.
3. Edit `smoke-test.yml`: set `SMOKE_COLLECTIONS` (must be readable) and
   `SMOKE_SEEDED_COLLECTIONS` (must contain rows in dev).
4. In `policies/apps.yaml`, define one read-only policy per consuming app
   (website, kiosk, mobile...). Generate every UUID with `uuidgen`; never copy
   IDs from another project.
5. The Makefile derives the Compose project name from the directory
   (`<dir>-cms`); override with `make up PROJECT=...`.
6. Copy `.env.example` to `.env`, fill in credentials, run `make up`, then run
   the checks in "Verify".

Do not change the pinned image version without reading that version's schema
API docs (see "Schema sync rules").

## Schema YAML (project format, not a Directus snapshot)

One collection per file, allowed top-level keys: `collection`, `schema`,
`meta`, `fields`, `relations`, `items`. The loader rejects anything else.

- Every collection declares a primary key (`schema.is_primary_key: true`).
  Collection and field names match `^[a-zA-Z][a-zA-Z0-9_]*$`; names are
  globally unique (folders are namespaces only); never start with `directus_`.
- `type` is storage; `meta.interface` is the editor. Aliases use
  `type: alias` and `schema: null`.
- `relations` is the **complete** list of outgoing relations for that
  collection once declared. Both ends must exist. A relation to
  `directus_files` must set `schema.foreign_key_column: id` (system
  collections are not introspectable). `meta.one_field` must name an alias
  field on the target.
- Multilingual content: a `languages` collection (string `code` primary key,
  `direction` ltr/rtl), a `<x>_translations` junction collection (hidden,
  with `<x>_id` and `languages_code`), a `translations` alias on the parent,
  and two relations, exactly as in `templates/schemas/content/`. WYSIWYG HTML
  is a `text` field with `meta.interface: input-rich-text-html`; clients must
  sanitize it.
- Slug-like values: validate with `meta.validation` regex. Uniqueness per
  language is **not** enforced by the schema; say so in a field note.
- Inline `items` on a schema file are **reference data** (e.g. languages):
  seeded in every environment, only when the primary key is missing.
- Directus validation is not a substitute for DB constraints or business rules;
  document rules the schema cannot enforce.

## Schema sync rules (do not weaken)

`apply-schemas.js` is deliberately conservative. Keep these properties in any
adaptation:

1. Read and validate **all** YAML before touching the instance.
2. Fetch `/schema/snapshot`, build the desired snapshot **from it**, preserving
   unmanaged collections, fields, relations and system-field indexes, then
   `POST /schema/diff` and `POST /schema/apply` with the returned diff. Empty
   diff is success. Never bypass hash/version/vendor checks; on a conflict,
   stop and review.
   **Wrong:** submitting only the YAML collections as the snapshot; omitted
   collections are treated as deletions.
3. Directus 11.17.4 uses full version-1 snapshots with no partial/merge mode.
   Verify the API of any other pinned version before changing the sync.
4. Ownership: a collection named in YAML becomes managed (even if it already
   exists: warn before adopting). Managed names are recorded in
   `/directus/schema-state/managed-collections.json` (the `schema-state`
   volume; back it up with the database). Removing a managed collection or
   field **deletes its data**. Unrelated collections are always preserved, and
   deleting a collection or field that an unmanaged collection references is
   refused. Never allow an empty `schemas/` dir to silently delete everything
   without explicit approval.
5. Errors are actionable, exit nonzero, and never print tokens, passwords or
   payloads.

## Seeds and environments

- `CMS_ENV` is `dev` (default) or `prod`; any other value is an error.
  Never infer dev from missing configuration in production deployments: set it
  explicitly there.
- `seeds/<domain>/<collection>.yaml`: `collection`, `items`, optional
  `required: true`. Without `required` the file is **example data, dev only**.
  With `required: true` it is configuration/reference data loaded in every
  environment.
- Seeding is idempotent and non-destructive: collection seeds run only when the
  collection is empty; singleton seeds only when the singleton has no record;
  inline schema `items` only when the primary key is missing. Existing rows are
  never overwritten, so editing a seed does not update existing installs.
- Nested translation records go inside the parent item. Quote dates in YAML.
  Seed dependencies before dependents; do not assume auto-increment IDs.
- `make reseed` wipes database, uploads and schema-state volumes. It is the only
  way to re-seed. Never run it against data worth keeping.

## Access policies

- `policies/apps.yaml` defines one least-privilege, **read-only**, no-admin,
  no-app-access policy per consumer, with a keyless service user. Use filters
  (`status = published`, publish/expiry windows with `$NOW`) so consumers
  cannot read drafts; restrict `fields` on sensitive collections instead of
  `['*']`.
- The loader refuses to take over an ID already used with different
  attributes, and refuses unexpected permissions or access links on managed
  policies. Resolve those manually, never by loosening checks.
- Service-user tokens are **not** managed. Create them in the admin UI per
  environment; they are lost on `make reseed`. `ADMIN_TOKEN` (set in `.env`)
  is the fixed admin token assigned on bootstrap so frontends' read tokens
  survive reseeds in development; never reuse it in production.

## Docker and entrypoint rules

- Pin `directus/directus:<exact version>`. Secrets come from environment
  variables (`${VAR:?message}` in Compose), never from Git. Bind the port to
  `127.0.0.1`. Postgres has a healthcheck; Directus `depends_on` it healthy.
- Entrypoint: `set -eu`, trap signals and always kill the temporary server,
  wait for `/server/ping` with a deadline (120 s), authenticate with
  `ADMIN_EMAIL`/`ADMIN_PASSWORD`, run the sync, `exec` the public server.
- The Directus container healthcheck is `/server/ping`. Database credentials
  initialize a **new** volume only; changing them later does not alter an
  existing Postgres user.
- MCP: Directus 11.17.4 supports it; enable it in admin settings and connect
  with a scoped user. Verify support before assuming it on another version.

## Verify before claiming done

1. `node --test scripts/*.test.js` (unit tests; fast, no Docker).
2. Isolated stack: `docker compose -p <unique> up --build -d --wait` with
   throwaway credentials (see `smoke-test.yml` for how CI generates them),
   then `scripts/smoke-test.sh`, then `docker compose -p <unique> down -v`.
   Use a disposable project name; **never** run `down -v` or `reseed` against
   a user's existing project or volumes.
3. Also exercise: repeat startup (second run reports "up to date" and writes
   nothing), a schema change, preservation of an unmanaged collection, `prod`
   seed exclusion, and an invalid YAML (container must fail, not serve).
4. Report anything not run. Unit tests do not cover `apply-schemas.js` (it needs
   a live Directus); do not claim schema sync was verified without step 2.

## Document it

Every repo's README/AGENTS.md states: how to start (`.env`, `make up`), the
environment variables, schema ownership and the destructive-removal warning,
the seed policy (`CMS_ENV`, `required`, "edits don't update existing rows"),
`make reseed` danger, service-user tokens, backup of the three volumes
together, and "rebuild the image after editing schemas, seeds, policies or
scripts". Update docs in the same change as any schema, seed or policy change.

## When requirements are unclear

Inspect the repo and existing instance first. Ask before: enabling automatic
deletion, adopting existing collections, changing translation modelling,
choosing relation delete behavior (`CASCADE` / `RESTRICT` / `SET NULL`), and
anything touching production data.
