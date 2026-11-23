---
name: directus-backend-bootstrap
description: Design or implement a Docker-based Directus backend with namespaced YAML schemas, startup synchronization, and optional development seeds.
---

# Bootstrap a Directus backend

Use this skill when setting up a Directus backend or adding declarative
collection schemas and seed data to one. Adapt it to the target project; do
not assume the project has this repository's scripts, collection names, or
database. Check the installed Directus version and its matching documentation
before choosing API features.

## Plan the data model first

1. Inspect the repository, deployment configuration, existing collections, and
   credentials strategy. Ask about ambiguous behavior, relationships,
   translations, environments, and data retention before implementing.
2. Organize definitions by domain, with one collection per YAML file. Folder
   names are organizational namespaces, not automatic Directus collection
   prefixes. Collection names must be globally unique.
3. Decide which collections are managed and who owns existing data. Default to
   non-destructive changes; ask for explicit approval before enabling automatic
   removal of collections or fields.

Example structure:

```text
Dockerfile
compose.yaml
entrypoint.sh
package.json
scripts/
  apply-schemas.js
  seed-data.js
schemas/
  content/
    articles.yaml
    article_translations.yaml
seeds/
  content/
    articles.yaml
```

## Define collection YAML

Use the Directus collection-creation payload shape for `collection`, `schema`,
`meta`, and `fields`. This is a project-specific format, **not** a Directus
schema snapshot; the loader must translate it before using the schema API.
Give every collection an explicit primary key and validate names, field types,
duplicate names, and supported properties before modifying the database.
Directus field `type` describes storage; `meta.interface` controls the editor.

```yaml
collection: articles
schema: {}
meta:
  icon: article
fields:
  - field: id
    type: integer
    schema:
      is_primary_key: true
      has_auto_increment: true
    meta:
      interface: input
      hidden: true
      readonly: true
  - field: title
    type: string
    schema:
      is_nullable: false
    meta:
      interface: input
      required: true
```

For relationships, extend the project format explicitly (for example with a
`relations` array) and translate it into Directus snapshot relations. Create
all collections and fields before relations; validate both ends and deletion
behavior. Define aliases with `type: alias` and `schema: null` where needed.
For multilingual content, model a shared languages collection, a translation
junction collection, and the parent translations alias and relations. Set
language direction for right-to-left languages. For WYSIWYG HTML, use a `text`
field with `meta.interface: input-rich-text-html`; sanitize HTML in clients.
Directus field validation is not a substitute for database constraints or
cross-field/business-rule validation.

## Bootstrap and synchronize

1. Pin a Directus image version; use an image version with the capabilities
   required by the project. Configure the database, persistent uploads, and
   credentials through environment variables. Keep secrets out of Git and bind
   local development ports to localhost. With Compose, wait for a healthy
   database before starting Directus.
2. The entrypoint should fail on errors, run Directus bootstrap/migrations, then
   start a temporary Directus server on a private loopback port. Wait for
   `/server/ping` with a deadline, authenticate with a securely supplied admin
   account or token, and synchronize schemas before starting the normal server.
   Ensure signal handling cleans up the temporary process, and do not expose
   the public service until synchronization succeeds.
3. Read and validate all YAML definitions first. Fetch `/schema/snapshot`,
   build a desired snapshot preserving out-of-scope collections, fields,
   relations, and system-field indexes, then call `/schema/diff` followed by
   `/schema/apply` with the returned diff and hash. Handle an empty diff without
   treating it as an error. Never bypass hash/version/vendor checks silently;
   on a conflict, stop and regenerate/review the diff.
4. Schema API behavior is version-specific. In particular, Directus 11.17.4
   uses full version-1 snapshots and does not provide the newer partial
   snapshot/merge-mode guarantees. Do not send collection YAML directly to
   `/schema/diff` or assume partial snapshot support without verifying the
   target version. Preserve snapshot metadata not explicitly owned by YAML.
5. If mirror mode is explicitly approved, keep a durable, database-specific
   ownership manifest for previously managed collections. New definitions
   adopt matching existing collection names, so warn before adoption. Retain
   unrelated collections and relations; reject deletes that would damage
   unrelated data. Persist and back up the manifest with the database, handle
   interrupted applies and concurrent instances safely, and refuse destructive
   actions when ownership state is missing, invalid, or ambiguous. An empty
   schema directory must not silently delete everything.
6. Log actionable errors and exit nonzero on invalid definitions, failed
   authentication, schema conflicts, or failed apply. Do not log tokens,
   passwords, or sensitive payloads.

**Right:** start from the instance snapshot and preserve unmanaged collections
before computing a diff. **Wrong:** submit only the YAML collections as a
full snapshot: Directus may interpret omitted collections as deletions.

## Seeds and environment

Separate required reference data from optional example data. Load required
reference records idempotently by stable primary key after schema apply in all
environments. Keep examples under `seeds/<namespace>/` and load them in a
separate module only when an explicit development setting such as
`CMS_ENV=dev` is present; default to no examples. Never infer development from
missing configuration.

```yaml
collection: articles
items:
  - title: Example article
```

Do not overwrite existing records. Define a repeatable policy for partially
populated collections and singletons, and make retries safe after interruption.
Use stable keys or resolve references from returned IDs rather than assuming
auto-increment IDs. Seed dependencies before dependents and handle nested
translation records deliberately. Quote dates in YAML to prevent parser-specific
date coercion. Document whether deleting data causes it to be seeded again.

## Delivery checklist

- Document startup, environment settings, schema ownership, destructive
  behavior, backups, seed policy, and how to rebuild after YAML changes.
- If MCP is needed, verify support in the pinned version and document how to
  enable it and connect with appropriately scoped permissions; capability and
  project-level enablement are separate.
- Unless the user requests otherwise, test with an isolated disposable database:
  fresh bootstrap, repeat startup, schema changes, preservation of unmanaged
  data, relation and translation behavior, reference/development seed
  idempotence, production seed exclusion, and explicit error paths. Never run
  destructive checks against a user's existing database or volumes.
- Validate the exact pinned version's API and image startup behavior. Report
  anything not tested rather than presenting an example as verified.
