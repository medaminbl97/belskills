---
name: add-i18n-content
description: This skill should be used when the user asks to set up i18n, add i18next, add translations/localization, or make an existing i18next setup fully typed. Installs i18next + react-i18next, creates a typed `resources` module that drives i18next's type augmentation automatically (so every `t()` call becomes typed off the actual JSON content), and wires it into the app entry — without authoring any content (that's the `add-i18n-content` skill's job).
argument-hint: [--locale <code>] [--namespaces <name1,name2,...>]
---

# Setup i18n (typed)

**Invoke:** `/add-i18n-content` when setting up i18next, adding typed localization infrastructure, or wiring typed translation resources.

Install i18next + react-i18next and wire up a **fully typed** setup where
TypeScript derives translation keys automatically from the JSON namespace
files — no hand-maintained key unions, no `t('some.key' as any)`.

This skill only sets up the **plumbing**. It creates empty-or-minimal
namespace JSON files as placeholders; actual content authoring from
reference images is the `add-i18n-content` skill's job.

## Step 1 — gather parameters

Ask (or infer) if not given:

1. **Primary content locale** — the locale code the project will author
   content in first (e.g. `de`, `en`, `fr`). Default to `en` if the user has
   no preference. Call this `$LOCALE`.
2. **Initial namespaces** — the top-level namespace files to create.
   Namespaces usually correspond to major feature areas / step groups (e.g.
   `common`, `investment-goals`, `investor-profile`). If the user has no
   list, start with just `common` and tell them more can be added later by
   dropping new `*.json` files into `src/locales/<locale>/` and listing them
   in the `resources` object.
3. **Additional locales** (optional) — if the user wants multi-locale from
   day one, collect the extra codes. Otherwise, scaffold for one locale now;
   adding more later is a mechanical copy of the directory.

Confirm the plan before writing any files:

```
Setup plan:
- Primary locale: <$LOCALE>
- Namespaces: <common, ...>
- Additional locales: <none | fr, it, ...>
- Files to create:
    src/locales/<$LOCALE>/<namespace>.json  (one per namespace)
    src/locales/i18n.ts
    src/locales/i18next.d.ts
- Files to modify:
    src/main.tsx (or the project's entry file) — import './locales/i18n'
    package.json — add i18next, react-i18next
```

## Step 2 — install dependencies

```bash
npm install i18next react-i18next
```

Only these two. Do **not** add `i18next-browser-languagedetector`,
`i18next-http-backend`, or similar unless the user explicitly asks — they
add runtime complexity and aren't needed for a static, bundled, typed
setup.

## Step 3 — create the namespace JSON files

For each namespace in the initial list, create
`src/locales/<$LOCALE>/<namespace>.json` with an empty object:

```json
{}
```

That's it. Content is the `add-i18n-content` skill's responsibility. The
empty object is valid JSON, parses cleanly, and TypeScript will type it as
`{}` until keys are added.

If the user listed additional locales, create the same set of empty files
under each `src/locales/<other-locale>/` directory. Only the **primary
locale** drives type inference (see Step 4) — other locales are expected to
mirror its shape but TypeScript doesn't enforce that at the type level
(runtime i18next falls back if a key is missing).

## Step 4 — create `src/locales/i18n.ts` (the typed resources module)

This is the **core** of the typed setup. The file both initializes i18next
_and_ exports the `resources` object whose shape TypeScript will reuse for
`t()` key inference.

```ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Import every namespace JSON for the primary locale.
// Each import gives a strongly-typed object matching the JSON's actual shape.
import common from './<$LOCALE>/common.json'
// import investmentGoals from './<$LOCALE>/investment-goals.json'
// ...one import per namespace

export const defaultNS = 'common'

export const resources = {
  <$LOCALE>: {
    common,
    // 'investment-goals': investmentGoals,
    // ...one entry per namespace, key = namespace filename without .json
  },
} as const

i18n.use(initReactI18next).init({
  resources,
  lng: '<$LOCALE>',
  fallbackLng: '<$LOCALE>',
  defaultNS,
  interpolation: {
    escapeValue: false, // React already escapes
  },
})

export default i18n
```

Notes:

- `as const` is **mandatory** on `resources`. Without it, TypeScript widens
  every string value to `string` and `t()` keys collapse to `string`
  instead of the literal key paths. This is the single most common mistake.
- Namespace key names in `resources.<locale>` must **match the JSON
  filename** (without `.json`). Kebab-case filenames like
  `investment-goals.json` become quoted keys: `'investment-goals':
investmentGoals`.
- One import per namespace; keep the import name camelCase even when the
  filename is kebab-case.

## Step 5 — create `src/locales/i18next.d.ts` (the type augmentation)

This file wires the `resources` object's inferred type into i18next's own
`CustomTypeOptions`, which is what makes `useTranslation()` and `t()` fully
typed everywhere.

```ts
import 'i18next'
import type { defaultNS, resources } from './i18n'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS
    resources: (typeof resources)['<$LOCALE>']
  }
}
```

Notes:

- The
