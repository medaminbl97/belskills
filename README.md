# belskills

Shared agent skills, grouped by tech stack. Each skill is a folder containing a `SKILL.md`.

## Skills

### React — [`react/`](react/)

| Skill | What it does |
| --- | --- |
| [`add-i18n-content`](react/add-i18n-content/SKILL.md) | Sets up typed i18next + react-i18next, with translation keys derived from the JSON namespace files. |
| [`api-query-integration`](react/api-query-integration/SKILL.md) | Integrates a backend API: OpenAPI clients, React Query query functions, options and keys, data validation and route loaders. |
| [`create-component`](react/create-component/SKILL.md) | Builds a React + shadcn component (also from reference images) by reusing the existing component tiers. |

### Directus — [`directus/`](directus/)

| Skill | What it does |
| --- | --- |
| [`directus-backend-bootstrap`](directus/directus-backend-bootstrap/SKILL.md) | Designs or implements a Docker-based Directus backend with namespaced YAML schemas, startup sync and optional dev seeds. |

### Tooling — [`tooling/`](tooling/)

Skills that work with any stack.

| Skill | What it does |
| --- | --- |
| [`commit-changes`](tooling/commit-changes/SKILL.md) | Groups uncommitted changes by feature and dependency order, then commits them with clear messages on one feature branch per area. |
| [`setup-pre-commit`](tooling/setup-pre-commit/SKILL.md) | Creates a `.pre-commit-config.yaml` that fits the project (lint, typecheck, format, commit messages), installs it and checks that the hooks run. |

## Usage

Add this repo to a project as a git submodule:

```sh
git submodule add git@github.com:medaminbl97/belskills.git .agents/skills
```

After cloning a project that uses it:

```sh
git submodule update --init
```

## Adding a skill

1. Pick the folder for the skill's stack, or create a new one (e.g. `python/`).
2. Add `<stack>/<skill-name>/SKILL.md` with `name` and `description` frontmatter. `name` must match the folder name.
3. Add a row for it to the table above.
