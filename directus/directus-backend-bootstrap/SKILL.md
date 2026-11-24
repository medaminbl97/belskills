---
name: directus-backend-bootstrap
description: Use whenever a repo needs a Directus backend or changes to one (collections, fields, relations, translations, money fields, renames, seeds, access policies, startup, CI). Defines our standard Docker + Postgres flow: YAML schemas that turn into reviewed Alembic-style revisions (generated schema changes plus hand-written up/down SQL for data), applied at startup, environment-aware seeds, YAML-managed access policies and service users, a Makefile, unit tests and a smoke test, and ships ready-to-copy templates so every repo works the same way.
---

# Directus backend: our standard flow

Every repo with a Directus backend uses **the same flow and the same files**.
Do not invent a new layout. For a new backend, copy `templates/` (next to this
file) and adapt it. For an existing backend, compare it with `templates/` and
converge on it, asking before any destructive change.

The templates are the generic version of a backend that runs in production
repos. They are tested: `npm test` passes, the stack starts and applies its
revisions, passes `tools/verify.mjs` and `scripts/smoke-test.sh`, and a second
start reports "Revisions are up to date".

## The flow in one paragraph

Collections are declared as YAML in `schemas/<domain>/`: the model, and the only
place you edit it. A change to the YAML becomes a **revision** with
`make revision m="short name"`: a folder in `revisions/` with a generated schema
snapshot and change list, plus optional hand-written `up.sql` / `down.sql` for
data. The image bakes in the schemas, `revisions/`, `access/` policies, `seeds/`
and the loader. On every container start the entrypoint runs Directus
`bootstrap`, starts a **temporary private server** on loopback, runs
`scripts/sync.js` (validate everything, apply pending revisions, then access
policies, then seeds), stops the temporary server, and only then starts the
public one. If anything fails the container exits nonzero and never serves.
Changing YAML or revisions means rebuilding the image (`make up`).

## Standard layout

```text
Dockerfile              pinned directus/directus image + loader baked in
compose.yaml            postgres + directus; volumes: database, uploads
entrypoint.sh           bootstrap -> temp server -> sync.js -> public server
Makefile                up | down | restart | logs | test | reseed (guarded)
                        revision | migrate-status | migrate-down | migrate-stamp | check
package.json, package-lock.json   only js-yaml (loader dependency); `npm test`
.env.example            documented variables; .env is never committed
schemas/<domain>/*.yaml one collection per file: the model
revisions/NNNN_name/    one folder per schema change, committed:
  schema.json             generated: Directus schema after this revision
  changes.json            generated: what up and down change (for review and as a guard)
  up.sql, down.sql        optional, hand-written: data steps
access/*.yaml           public policy and managed roles/policies/service users
seeds/reference/*.yaml  always loaded
seeds/examples/*.yaml   loaded only when CMS_ENV=dev
scripts/                baked into the image, except tests and the smoke test:
  schema-model.js         load + validate YAML, desired snapshot, Directus REST helpers
  revisions.js            generate / upgrade / down / status / stamp / check
  sync.js                 startup: validate -> revisions -> access policies -> seeds
  apply-policies.js       policy / role / permission / service-user reconciliation
  seed-data.js            idempotent, environment-aware seeding
  *.test.js               unit tests (node --test scripts/*.test.js)
  smoke-test.sh           quick check of a running stack
tools/                  local helpers, not in the image:
  init-env.mjs            creates .env with random credentials (never overwrites)
  verify.mjs              live check of schemas, access and seeds against YAML
  revision.sh             behind `make revision` (throwaway stack, copies the revision out)
  revisions-cli.sh        runs revisions.js in the running container (`make migrate-*`, `check`)
.github/workflows/smoke-test.yml   PR gate: unit tests + docker smoke test + `check` + verify
AGENTS.md / README.md   document the behavior below (see "Document it")
```

`scripts/` holds exactly these files. Do not add loader modules next to them;
extend them instead. Project-specific one-off checks go in `tools/`.

## Setting up a new repo

1. Copy `templates/` into the repo root, **including dotfiles** (`.env.example`,
   `.dockerignore`, `.gitignore`, `.github/`). Merge with, never overwrite,
   existing files. In a monorepo put it in a folder (for example `directus/`)
   and adjust the workflow paths.
2. Replace the example `articles` collections, seeds and `access/public.yaml`
   with the real ones. Keep `languages` only if the project is multilingual.
   Delete the shipped `revisions/0001_initial/` (it describes the example) and
   create your own: `make revision m="initial"`.
3. Set `SMOKE_COLLECTIONS`, `SMOKE_SEEDED_COLLECTIONS`, `SMOKE_PUBLIC_COLLECTION`
   and `SMOKE_PRIVATE_COLLECTIONS` for the smoke test (defaults match the
   examples; private collections must exist and be denied to anonymous users).
4. Run `make up` (creates `.env`, builds, applies the revisions, waits until
   healthy), then the checks in "Verify".
5. The Makefile derives the Compose project name from the directory
   (`<dir>-cms`); it names the containers and volumes, so keep it stable.

**Adopting an existing database** (created by an earlier YAML sync, or restored):
write the YAML to match it, run `make revision m="initial"` to generate
`0001_initial`, start with `make up`, then `make migrate-stamp` to record it as
applied without running it, and confirm with `make check`. Applying `0001`
onto a database that already matches it is also harmless, because the diff is
empty. Stamp when a revision has data steps that must not run again.

Do not change the pinned image version without reading that version's schema
API docs (see "Revision rules").

## Schema YAML (project format, not a Directus snapshot)

One collection per file, allowed top-level keys: `collection`, `schema`, `meta`,
`fields`, `relations`. The loader rejects anything else. Every field needs a
`meta` block (it can be small, such as `interface: input`).

- Every collection declares a primary key (`schema.is_primary_key: true`).
  Collection and field names match `^[a-zA-Z][a-zA-Z0-9_]*$`; names are
  globally unique (folders are namespaces only); never start with `directus_`.
- `type` is storage; `meta.interface` is the editor. Aliases use
  `type: alias` and `schema: null`.
- `relations` is the **complete** list of outgoing relations for that
  collection. Both ends must exist. A relation to `directus_files` must set
  `schema.foreign_key_column: id` (system collections are not introspectable).
  `meta.one_field` must name an alias field on the target.
- Use UUID primary keys (`special: [uuid]`) for anything that is seeded: seed
  rows need stable keys, and auto-increment ids cannot be relied on.
- Multilingual content: a `languages` collection (string `id`), a
  `<x>_translations` collection (`parent`, `language`, content fields), a
  `translations` alias on the parent, and two relations, exactly as in
  `templates/schemas/content/`. Translations are separate rows, **not** nested
  inside the parent in seeds.
- WYSIWYG HTML is a `text` field with `meta.interface: input-rich-text-html`;
  clients must sanitize it. Every body/description the website renders is rich
  text; short labels stay plain.
- Slug-like values: validate with `meta.validation` regex. Uniqueness per
  language is **not** enforced by the schema; say so in a field note.
- Directus validation is not a substitute for DB constraints or business rules;
  document rules the schema cannot enforce. Choose relation delete behavior
  deliberately: translations and join rows `CASCADE`, everything else
  `RESTRICT` (archive instead of delete).

### Money

- Store amounts as **exact decimals in the currency's main unit**, for example
  euros: `type: decimal` with `schema.numeric_precision: 12` and
  `numeric_scale: 2` (see `articles.price`). Never use float/double, and do not
  store integer cents in the CMS.
- Name the field after what it is (`unit_amount`, `goal_amount`, `total_amount`,
  `amount`), not `_cents`. Add `meta.note: Amount in euros (EUR) with two
  decimal places.` and `validation: _gte: 0`.
- Converting existing cents is **one revision**: the YAML drops `goal_cents` and
  declares `goal_amount`; the generator lists `- campaigns.goal_cents` and
  `+ campaigns.goal_amount`; `up.sql` is `UPDATE campaigns SET goal_amount =
  goal_cents / 100.0;` and `down.sql` is `UPDATE campaigns SET goal_cents =
  round(goal_amount * 100)::integer;`.
- **Directus returns decimals as strings** (`"12.50"`) although its OpenAPI
  export says `number`. A frontend that validates responses with generated Zod
  schemas must declare these fields as decimal strings (match on the note text
  in the generator config), and should convert to integer cents at the API
  boundary if it does arithmetic or talks to a payment provider.

## Revisions

A revision is one reviewed schema change, like an Alembic revision.

**Workflow:** edit `schemas/`, run `make revision m="goal to euros"`, read
the printed change list, add `up.sql` / `down.sql` if data moves, run `make up`,
commit the whole `revisions/NNNN_name/` folder together with the YAML.

- `make revision` builds the image, starts a **throwaway stack** (its own
  Compose project `<project>-gen`, removed afterwards) at the newest revision,
  diffs the YAML against it, and copies the new folder out. It never touches
  your data. The throwaway stack starts with `REVISIONS_ONLY=true`, so access
  and seeds (which may refer to the new collections) are skipped.
- `schema.json` and `changes.json` are **generated**; do not edit them. Lines in
  `changes.json` are `+ added`, `- removed` (`DESTRUCTIVE`: the data in it is
  lost) and `~ changed`. Review every `-` line.
- Folders are numbered `0001`, `0002`, ... without gaps, and checked at
  startup. **Never edit a revision that was applied anywhere**: make a new one.
- A rename cannot be detected, only seen as `- old` plus `+ new`. Put the copy
  in `up.sql`.
- `up.sql` / `down.sql` move **data only**. The loader refuses `ALTER`,
  `CREATE`, `DROP`, `TRUNCATE ... TABLE/INDEX/...`, `RENAME` and any `directus_*`
  table: the schema is the YAML's job, Directus's tables are Directus's. Each
  runs in one transaction. They go through knex `raw`, so write a literal `?`
  as `\\?`. Provide `down.sql` whenever `up.sql` moves or `changes.json` drops
  data, so a rollback restores it.
- **Order of one revision:** add what is new (and changed), then `up.sql`, then
  drop what is removed. So `up.sql` reads the old field and writes the new one
  in the same revision. `down` is the mirror: re-add, `down.sql`, drop.
- Every step is recorded (`added`, `sql`, `done`, and `down-added`,
  `down-sql` while undoing), so an interrupted run continues where it stopped
  (`make migrate-status` shows `partial`). A half-undone revision refuses to be
  applied again until `down` finishes.
- **Rollback:** run `make migrate-down` (once per revision, newest first) with
  the image that contains the revision, **then** deploy the older image. An
  image that lacks revisions the database has applied refuses to start ("run
  `down` with the newer release first"); skipping `down` would otherwise leave
  new fields empty on the next upgrade. After `down`, `make restart` applies it
  again.
- Revisions are recorded in `app_meta.revisions`, a separate Postgres schema
  that Directus never sees. They are not Directus migrations (`MIGRATIONS_PATH`
  is unused).
- If the YAML changes without a revision, startup **warns** ("run
  `make revision`"), `make check` and CI **fail**. `make check` rebuilds first,
  because the YAML is baked into the image.
- `make migrate-stamp [REV=head|<id>]` records revisions as applied without
  running them (adoption, restored databases). It changes no schema.

## Revision rules (do not weaken)

`revisions.js` and `schema-model.js` are deliberately conservative. Keep these
properties in any adaptation:

1. Read and validate **all** YAML and revision files (names, numbering, SQL
   rules) before touching the instance.
2. Schema changes go through Directus: fetch `/schema/snapshot`, build the
   desired snapshot **from it**, then `POST /schema/diff` and `/schema/apply`.
   **Wrong:** submitting only the YAML collections as the snapshot; omitted
   collections are treated as deletions. A revision stores its target
   snapshot and the diff is computed when it is applied (stored diffs break on
   Directus's schema hash, and a field recreated by a rollback is not
   byte-identical).
3. Directus 11.17.4 uses full version-1 snapshots with no partial/merge mode.
   After changing the pinned version, re-run the scenarios in "Verify" and
   generate the next revisions with that version.
4. **The YAML is the complete definition of every collection it declares.**
   Fields and relations of those collections that the YAML no longer mentions
   show up as `-` lines in the next generated revision.
5. **Deletions are explicit.** A live diff that would delete something the
   revision's `changes.json` does not list (for example a field someone added
   in the admin app) is refused: the database has drifted, fix that first.
   There is no deletion switch and no `PRUNE`.
6. **Ownership:** a collection is ours if any revision ever contained it.
   Removing its YAML file produces a `- name` line (DESTRUCTIVE) in the next
   revision, so it is dropped through review like any field. Collections no
   revision ever contained (created by hand, or by another app on the same
   database) are never touched, including their data.
7. Errors are actionable, exit nonzero, and never print tokens, passwords or
   payloads.

## Seeds and environments

- `CMS_ENV` is `dev` (default in Compose) or `prod`; any other value is an
  error. `sync.js` treats an unset value as `prod`. Set it explicitly in every
  deployment; never infer dev from missing configuration.
- `seeds/reference/` is configuration data loaded in every environment.
  `seeds/examples/` is demo data loaded only when `CMS_ENV=dev`. Files apply in
  file-name order: prefix them `01-`, `02-`, ... so referenced rows come first.
- A seed file has `collection` and `items`; every item has a stable primary key
  and only real (non-alias) fields. Quote timestamps in YAML.
- Seeding creates only **missing rows**, matched by primary key, and never
  overwrites an existing row, so editing a seed does not update existing
  installs: a revision's `up.sql` fixes existing rows (a rename leaves the new
  columns at their default until it does). A seeded row an editor deleted is
  created again on the next start.
- `SEED_PUBLISH_DEMO=true` publishes example rows that are still drafts. Never
  set it in production.
- `make reseed CONFIRM=yes` wipes the database and uploads volumes. It is the
  only way to re-seed from scratch, and it also destroys static tokens. Never run
  it against data worth keeping.

## Access (`access/*.yaml`)

- `policy: public` configures the built-in Public policy (anonymous visitors):
  read-only, published rows only (`status = published`, publish/expiry windows
  with `$NOW`), explicit `fields` lists instead of `['*']`, and related
  translation rows filtered through their parent. Renaming a field means
  updating these lists in the same change.
- A managed policy file has `policy` (name, flags), optional `role` and `user`,
  and `permissions`:

  ```yaml
  role: { name: Service }
  policy: { name: service-policy, icon: lock, admin_access: false, app_access: false }
  user: { email: service@example.com, first_name: Service, last_name: User, token_env: SERVICE_TOKEN }
  permissions:
    - { collection: articles, action: read, fields: [id, slug] }
    - collection: articles
      action: update
      fields: [status]
      permissions: { status: { _eq: draft } }     # which rows
      validation: { status: { _in: [draft, published] } }   # which values
  ```

- Policies are matched by name and **owned by the YAML**: the sync overwrites
  their flags and permissions, so UI edits do not survive a restart. Admin access
  is rejected. Give each service user the least privilege it needs, including
  write permissions limited by `permissions` and `validation`.
- Permissions that exist on a managed policy but are not in the YAML are
  reported as a warning, never deleted.
- The service user's static token comes from the environment variable named in
  `token_env` (32+ characters: letters, digits, `-`, `_`); with no value the user
  is skipped. Pass it through `compose.yaml`/the deployment, never commit it.
  Generate random values with `tools/init-env.mjs` for local use.
- Static admin/read tokens created in the Directus UI are **not** managed and are
  lost on `make reseed`.

## Docker, Compose and the Makefile

- Pin `directus/directus:<exact version>`. Secrets come from environment
  variables (`${VAR:?message}` in Compose), never from Git. Bind the port to
  `127.0.0.1`. Postgres has a healthcheck; Directus `depends_on` it healthy.
  `CACHE_SCHEMA=false` (relation updates can fail on cached constraint data).
- Entrypoint: `set -eu`, trap signals and always kill the temporary server,
  wait for `/server/ping` with a deadline (120 s), authenticate with
  `ADMIN_EMAIL`/`ADMIN_PASSWORD`, run `sync.js`, `exec` the public server.
- Database credentials initialize a **new** volume only; changing them later
  does not alter an existing Postgres user. If a deployment needs stable volume
  names across projects, set `name:` on the volumes.
- Makefile: `make up` (creates `.env` if missing, rebuilds, applies revisions,
  waits healthy), `down`, `restart`, `logs`, `test`, `reseed CONFIRM=yes`
  (refuses without the confirmation), `revision m="..."`, `migrate-status`,
  `migrate-down`, `migrate-stamp`, and `check`. The default project name must
  match the project that owns existing containers and volumes.
- `tools/revisions-cli.sh` runs through a file (`docker exec -d`, then poll)
  because attached `docker exec` output can be cut off in dev containers.
- MCP: Directus 11.17.4 supports it; enable it in admin settings and connect
  with a scoped user. Verify support before assuming it on another version.

## Verify before claiming done

1. `npm test` (unit tests; fast, no Docker). They load the real YAML and
   revisions, reject invalid definitions and revisions, and cover the snapshot
   builder, the revision state machine (including interrupted runs), the seeder
   and the access reconciliation with in-memory fakes.
2. Isolated stack: a disposable project name, throwaway credentials and, if the
   Compose file names volumes explicitly, different volume names. Then
   `docker compose up --build -d --wait`, `scripts/smoke-test.sh`,
   `tools/verify.mjs` (it also asserts that the instance matches the YAML), and
   `down -v` on **that disposable project only**. Never run `down -v` or
   `reseed` against a user's existing project or volumes.
3. Also exercise, with data in the tables: `make revision` for a rename and
   `make up` (values copied by `up.sql`, old field dropped), a second start
   ("Revisions are up to date", nothing written), `make migrate-down` then
   `make restart` (data round-trips, edits made meanwhile survive), `make check`
   failing for a YAML change without a revision, an image missing a revision
   refusing to start, `make migrate-stamp` on a database whose revision table
   is empty, adding and removing a collection through revisions, an untracked
   table surviving, `prod` seed exclusion, and an invalid YAML (container must
   fail, not serve).
4. In a dev container the published port is on the Docker host, not in the
   container: run the checks inside the compose network (a throwaway container
   with `curl` or `node`) or inside the directus container (copy `tools/` in),
   and read results from a file or the server logs if `docker exec` output
   looks empty.
5. Report anything not run. Unit tests do not cover the live revisions; do not
   claim they were verified without step 2. In-place column type changes
   (`~` lines) are applied by Directus as column alterations; test them with
   data before relying on them.

## Document it

Every repo's README/AGENTS.md states: how to start (`.env`, `make up`), the
environment variables, the revision workflow (`make revision`, `up.sql` /
`down.sql`, never edit applied revisions, `make migrate-down` before a
rollback, `make check` in CI), the seed policy (`CMS_ENV`, reference vs
examples, "edits don't update existing rows"), `make reseed` danger,
service-user tokens, the money rule, backup of the database and uploads
together, and "rebuild the image after editing schemas, revisions, access,
seeds or scripts". Update docs in the same change as any schema, seed or
policy change.

## When requirements are unclear

Inspect the repo and existing instance first. Ask before: adopting an existing
database (stamping), dropping data (any `-` line), editing an applied revision,
adopting existing collections, changing translation modelling, choosing
relation delete behavior (`CASCADE` / `RESTRICT` / `SET NULL`), and anything
touching production data.
