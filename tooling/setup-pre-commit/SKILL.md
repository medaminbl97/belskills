---
name: setup-pre-commit
description: This skill should be used when the user asks to set up pre-commit, add pre-commit hooks, add git hooks for linting/formatting/typechecking, or wire quality gates into commit time. Creates a `.pre-commit-config.yaml` tailored to the project's actual stack (frontend subdirectory or root, which npm scripts exist, whether YAML/shell/other file types are present), installs the pre-commit framework, and verifies the hooks run.
argument-hint: [--frontend-dir <path>] [--hooks <eslint,typecheck,prettier,yamlfmt,conventional-commit,...>]
---

# Setup pre-commit

**Invoke:** `/setup-pre-commit` when asked to configure pre-commit hooks or add commit-time linting, formatting, or type-checking gates.

Create a `.pre-commit-config.yaml` that wires the project's existing npm
scripts (and any relevant file-format hooks) into git's pre-commit stage,
so lint/format/typecheck failures surface **before** a commit lands rather
than in CI.

This skill does not invent new lint/format tooling — it assumes the project
already has an `eslint`, `prettier`, `tsc`-based typecheck, etc. set up via
npm scripts, and wires those into pre-commit. If a needed script is
missing, it stops and asks the user to add it (or to confirm skipping that
hook), rather than guessing a command.

## Step 1 — survey the project

Before writing any config, inspect:

1. **Repo layout** — is the frontend at the repo root, or in a
   subdirectory (e.g. `frontend/`, `web/`, `apps/web/`, or a product-named
   folder like `oekoheld2/`)? Call this path `$FRONTEND_DIR` (use `.` if
   it's the root). Determine this by:
   - Looking for `package.json` at root vs. in subdirectories.
   - Asking if ambiguous (monorepos may have multiple).
2. **Available npm scripts** — read `$FRONTEND_DIR/package.json`'s
   `scripts` block. Note which of these exist (names vary):
   - Lint: usually `lint`, sometimes `lint:fix`.
   - Format: usually `format`, `format:check`, or `prettier`.
   - Typecheck: usually `typecheck`, `type-check`, or `tsc`.
   - Test: usually `test`. (Default off — see Step 3.)
3. **Other file types** present in the repo that commonly have their own
   hooks:
   - `.yml`/`.yaml` files → yamlfmt / yamllint.
   - `.sh` scripts → shellcheck.
   - Markdown-heavy repos → markdownlint (ask).
4. **Commit message convention** — does the repo already use Conventional
   Commits? Check `git log --oneline -n 30`. If yes, offer the
   `conventional-pre-commit` hook on the `commit-msg` stage.
5. **Existing `.pre-commit-config.yaml`** — if one exists, read it first.
   Decide with the user: extend it, or replace it. Do not silently
   overwrite.

Present the discovered inventory and the proposed hook list to the user,
and get confirmation before writing files:

```
Discovered:
- Frontend dir: <$FRONTEND_DIR>
- npm scripts available: lint, format, typecheck, test
- Other file types: *.yml (2 files), *.sh (0 files)
- Existing .pre-commit-config.yaml: no
- Conventional Commits in history: yes

Proposed hooks:
- frontend-eslint       (runs: npm --prefix <$FRONTEND_DIR> run lint)
- frontend-typecheck    (runs: npm --prefix <$FRONTEND_DIR> run typecheck)
- frontend-prettier     (runs: npm --prefix <$FRONTEND_DIR> run format)
- yamlfmt               (jumanjihouse/pre-commit-hook-yamlfmt)
- conventional-commit   (compilerla/conventional-pre-commit, commit-msg stage)

Proceed?
```

## Step 2 — ensure the pre-commit framework is installed

`pre-commit` itself is a Python tool. Check availability:

```bash
pre-commit --version
```

If missing, install it. Prefer `pipx` (isolated, user-scoped) over `pip`:

```bash
pipx install pre-commit
# or, if pipx isn't available:
# pip install --user pre-commit
```

On macOS, `brew install pre-commit` is also fine. Do **not** add
`pre-commit` as an npm dev-dependency — it's not an npm package.

## Step 3 — write `.pre-commit-config.yaml`

Create the file at the **repo root** (never inside `$FRONTEND_DIR`, even
if the frontend is in a subdirectory — pre-commit runs from the repo
root).

Template (fill in `$FRONTEND_DIR` and keep only the hooks the user
confirmed):

```yaml
---
minimum_pre_commit_version: 3.7.0

default_language_version:
  python: python3.12

default_stages:
  - pre-commit

repos:
  - repo: https://github.com/jumanjihouse/pre-commit-hook-yamlfmt
    rev: 0.2.3
    hooks:
      - id: yamlfmt
        args: [--mapping, '2', --sequence, '2', --offset, '0', --width, '150']

  - repo: https://github.com/compilerla/conventional-pre-commit
    rev: v3.4.0
    hooks:
      - id: conventional-pre-commit
        stages: [commit-msg]
        args: [] # add allowed types here if the repo uses a restricted set

  - repo: local
    hooks:
      - id: frontend-eslint
        name: frontend-eslint
        entry: bash -c 'if [ ! -d ./<$FRONTEND_DIR>/node_modules ]; then npm --prefix ./<$FRONTEND_DIR> ci --no-audit --no-fund; fi; npm --prefix ./<$FRONTEND_DIR> run lint'
        language: system
        pass_filenames: false
        files: ^<$FRONTEND_DIR>/.*\.(ts|tsx|js|jsx)$

      - id: frontend-typecheck
        name: frontend-typecheck
        entry: bash -c 'if [ ! -d ./<$FRONTEND_DIR>/node_modules ]; then npm --prefix ./<$FRONTEND_DIR> ci --no-audit --no-fund; fi; npm --prefix ./<$FRONTEND_DIR> run typecheck'
        language: system
        pass_filenames: false
        files: ^<$FRONTEND_DIR>/.*\.(ts|tsx|js|jsx)$

      - id: frontend-prettier
        name: frontend-prettier
        entry: npm --prefix ./<$FRONTEND_DIR> run format
        language: system
        pass_filenames: false
        files: ^<$FRONTEND_DIR>/.*\.(ts|tsx|js|jsx)$
```

Adjustments by scenario:

- **Frontend at repo root (`$FRONTEND_DIR == '.'`)**: drop the
  `--prefix ./.` and the `./<dir>/` path segments — use plain
  `npm ci --no-audit --no-fund` and `npm run <script>`, and tighten
  `files:` to `\.(ts|tsx|js|jsx)$` without the directory anchor.
- **Different package manager** (`pnpm`, `yarn`, `bun`): swap `npm --prefix
  <dir> run <script>` for the equivalent (`pnpm --dir <dir> <script>`,
  `yarn --cwd <dir> <script>`, `bun --cwd <dir> run <script>`). Also swap
  the install bootstrap (`pnpm install --frozen-lockfile`, `yarn install
  --immutable`, `bun install --frozen-lockfile`).
- **Missing a script** (e.g. no `typecheck` script in `package.json`):
  stop and ask the user to add the script, rather than inlining `tsc
--noEmit` into the hook — keeping the real command in `package.json`
  means devs can run the same thing locally as the hook does, and the
  hook stays a one-liner.
- **Yaml-free repo**: drop the `yamlfmt` repo block entirely.
- **No Conventional Commits**: drop the `conventional-pre-commit` repo
  block entirely. Do not add it "just in case" — it will reject every
  commit that doesn't match the pattern.
- **Tests on pre-commit**: default **off**. Tests are usually too slow for
  pre-commit; put them in CI or on `pre-push` instead. Only add a
  `frontend-test` hook if the user explicitly asks.

Why the `if [ ! -d .../node_modules ]; then npm ci ...; fi` prelude on
lint/typecheck but not on prettier? Lint and typecheck need the project's
dependencies installed (eslint plugins, type definitions) to run at all;
prettier via `npm run format` typically only needs prettier itself, which
is already a dev-dep. If prettier in this project also needs plugins
loaded from `node_modules`, add the same bootstrap to its hook — but keep
it minimal otherwise.

Why `pass_filenames: false`? These hooks run project-level scripts
(`npm run lint` lints the whole project per its own config). Passing
individual filenames would require every hook to accept them as CLI args,
and most npm scripts don't. The `files:` regex still gates **whether** the
hook runs (only if a matching file changed), it just doesn't filter
**what** the script processes.

## Step 4 — install the git hook

```bash
pre-commit install
```

This writes `.git/hooks/pre-commit` (and `.git/hooks/commit-msg` if any
hook uses the `commit-msg` stage — the `conventional-pre-commit` hook
needs it). If the config includes `commit-msg`-stage hooks, also run:

```bash
pre-commit install --hook-type commit-msg
```

## Step 5 — verify

Run every hook once against all tracked files to confirm the config is
sound before relying on it at commit time:

```bash
pre-commit run --all-files
```

Expected behavior:

- First run may be slow (pre-commit clones and caches each `repo:` hook,
  and the `if [ ! -d node_modules ]` bootstrap may run `npm ci`). Subsequent
  runs are fast.
- Hooks that find issues will either auto-fix (prettier, yamlfmt) or report
  errors (eslint without `--fix`, typecheck, conventional-commit). Auto-fix
  hooks exit non-zero on first run so the user re-stages and re-commits.
- If a hook errors unexpectedly (not a code issue, but the hook itself
  failing to run — missing binary, wrong path), the config needs
  adjustment. Fix the config, then re-run `pre-commit run --all-files`.

Also test commit-msg validation (if the Conventional Commits hook is in
play) with a throwaway staged change:

```bash
git commit --allow-empty -m "bad message"   # should fail
git commit --allow-empty -m "chore: test commit-msg hook"   # should pass
```

Reset or amend afterward as needed.

## Step 6 — document for other devs

Add a short section to the project's README (or create one if absent)
explaining how to get the hooks on a fresh clone:

````md
## Development

This repo uses [pre-commit](https://pre-commit.com) to run lint, format,
and typecheck at commit time.

```bash
pipx install pre-commit   # once per machine
pre-commit install        # once per clone
pre-commit install --hook-type commit-msg   # if Conventional Commits are enforced
```
````

```

Keep it short — the config file itself is self-documenting beyond that.

## Guardrails

**DO:**

- ✅ Place `.pre-commit-config.yaml` at the **repo root**, always.
- ✅ Use `npm --prefix <dir> run <script>` (or the equivalent for
  pnpm/yarn/bun) to invoke scripts that live in a subdirectory.
- ✅ Keep hook `entry:` lines as thin as possible — the real command lives
  in `package.json` so devs can run it manually with the same result.
- ✅ Pin `rev:` to a specific tag for every third-party `repo:` block —
  never leave it floating on a branch.
- ✅ Confirm the plan with the user before writing the config.
- ✅ Run `pre-commit run --all-files` once at the end to validate.

**DO NOT:**

- ❌ Add `pre-commit` to `package.json` — it's a Python tool, installed
  globally per machine, not per project.
- ❌ Inline multi-line scripts into `entry:` beyond the small `node_modules`
  bootstrap — if logic grows past one line, move it into an npm script.
- ❌ Enable the Conventional Commits hook if the repo's history doesn't
  already use that convention — it will block normal commits.
- ❌ Enable test runs on pre-commit by default — too slow, pushes devs
  toward `--no-verify`. Put tests in CI / `pre-push`.
- ❌ Add hooks for file types the repo doesn't contain (no shellcheck in a
  repo with zero `.sh` files, no markdownlint in a repo with no `.md`
  content changes).
- ❌ Overwrite an existing `.pre-commit-config.yaml` without asking first.

## Notes

- **Why `language: system` instead of `language: node`?** Node-language
  pre-commit hooks create an isolated node env per hook, duplicating the
  project's `node_modules` and getting out of sync with the real
  toolchain. `system` runs the host's `npm`/`node` against the project's
  actual `node_modules`, which is what devs run manually — one source of
  truth.
- **Why not `husky` or `lefthook`?** They're fine alternatives, but
  pre-commit (the Python one) has broader hook-repo ecosystem support
  (yamlfmt, conventional-commit, shellcheck, etc. as drop-in `repo:`
  entries) and the user's existing config example uses it. Only switch if
  the user asks.
- **CI parity:** CI should run the same scripts the hooks run (`npm run
  lint`, `npm run typecheck`, `npm run format` — the latter as `--check`
  mode in CI, not write mode). Hooks and CI being thin wrappers around the
  same npm scripts keeps local and remote behavior aligned.
- **Updating hook versions:** `pre-commit autoupdate` bumps every `rev:`
  to the latest tag. Run periodically; review the diff before committing
  (occasionally a hook's new version changes defaults).
```
