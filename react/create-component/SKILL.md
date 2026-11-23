---
name: create-component
description: This skill should be used when the user asks to "create a component", "add a component", "make a new component", or invokes "/cc" (optionally with pasted reference images). Builds a React component for a React + shadcn project by reusing the existing component tiers (ui primitives, shared components, page-local components) instead of writing styling or behavior from scratch.
argument-hint: [pasted image(s)] <ComponentName> [brief description] [--page <page-name>]
---

# Create Component

**Invoke:** `/create-component` when asked to create, add, or build a React component, optionally using pasted reference images.

Create a new React component that composes the project's existing component tiers rather than reinventing them.

## Usage patterns

- `/cc <ComponentName> <description>` — build from a text description alone.
- `/cc <pasted image(s)> <ComponentName> and what it's for` — one or more reference images (mockup, screenshot, design export) are pasted alongside the name/purpose. Inspect the image(s) first: read off layout, spacing, typography, color usage, and interactive states, then build the component to visually match — still composed from tier 1/2 components wherever they already cover a piece of that UI (e.g. a pictured primary button maps to `Button` with `variant="default"`, not a hand-rolled `<button>`). Don't invent behavior the image doesn't show; ask only if the image is ambiguous about something functionally important (e.g. what a click does).

## Component tiers (check in this order)

1. **`src/components/ui/`** — shadcn primitives (buttons, inputs, dialogs, etc.), generated via `npx shadcn@latest add <name>`. These are the base building blocks (base-ui + class-variance-authority + `cn`).
2. **`src/components/`** — shared/common components used across multiple pages/routes (e.g. navigation bars, loading indicators, pending states). Built from tier 1.
3. **`src/pages/<page-name>/components/`** — components used only within a single page. Co-located with that page, built from tiers 1 and 2.

## Procedure

1. **Determine placement.**
   - If the component is specific to one page/route, place it in `src/pages/<page-name>/components/<kebab-case-name>.tsx`.
   - If it will be reused across pages/routes, place it in `src/components/<kebab-case-name>.tsx`.
   - If unsure and the user gave a `--page` arg, use that page. Otherwise infer from context (e.g. which page the user is currently working in) or ask only if genuinely ambiguous.

2. **Survey existing tier 1 and tier 2 components before writing anything.**
   - List `src/components/ui/` and `src/components/` to see what already exists.
   - If a needed shadcn primitive doesn't exist yet in `src/components/ui/` (e.g. `Dialog`, `Input`, `Card`), run `npx shadcn@latest add <name>` to install it rather than hand-building it.
   - Never duplicate styling/behavior that a tier 1 or tier 2 component already provides — import and compose it instead.

3. **Write the component.**
   - **Name the component, its file, and its props/types in English**, even when the request, reference image, or UI copy is in another language. Non-English UI text (labels, titles, button copy) stays in its original language since it's user-facing content — but identifiers (component name, file name, prop names, type names) are always English. E.g. a component for a user profile picker is named `ProfilePicker`, not a transliteration of the localized term; a step-progress bar for an application flow is `ApplicationStepsIndicator`, not a localized equivalent.
   - Functional component, named export matching the component name (match the existing pattern in the target tier — page-local components may default-export; shared components in `src/components/` typically named-export).
   - **Don't destructure props in the function signature unless a prop needs a default value.** Take the whole props object and access fields via `props.foo`: `const MyComponent = (props: MyComponentProps) => (...)`. Only destructure the specific props that need defaults, keeping the rest on `props`: `const MyComponent = ({ variant = 'default', ...props }: MyComponentProps) => (...)`, then reference the rest as `props.foo`. Don't fully destructure a props object that has no defaults just because that's a common React pattern elsewhere.
   - Use `cn` from `@/lib/utils` (which re-exports the `cn` package) for conditional classNames, not manual string concatenation.
   - Follow project code style (check the project's prettier/eslint config): functional components only.
   - Use the project's path aliases for imports (commonly `@/*` resolving to `src/*`), consistent with surrounding files.
   - Compose from `src/components/ui/*` primitives and any relevant `src/components/*` shared components rather than raw HTML elements where a primitive already covers it (e.g. use `Button` from `@/components/ui/button` instead of a raw `<button>`).
   - Do not add comments explaining what the code does. Do not over-engineer props beyond what was asked.

4. **Wire it up** if the user indicated where it's used (import it into the page/route that needs it). Don't invent usage sites that weren't requested.

5. **Create a story.** This is default behavior for every tier 2 (`src/components/`) and tier 3 (`src/pages/*/components/`) component — do it without being asked. Skip it for tier 1 (`src/components/ui/`) shadcn primitives unless the user explicitly asks for one, since those are generated/vendored components.
   - **Tier 2** (`src/components/`): story goes in `src/stories/<kebab-case-name>.stories.ts`, matching the existing convention — not co-located with the component.
   - **Tier 3** (`src/pages/*/components/`): story goes in `src/stories/<kebab-case-name>.stories.ts` as well, keeping all stories in the one `src/stories/` directory (there's no existing page-local story to follow, so use the same location/pattern as tier 2 rather than inventing a new co-located convention).
   - Use the existing `Meta`/`StoryObj` pattern from `@storybook/react` (check existing story files for the shape/conventions: `title: 'Components/<Name>'` or `'Pages/<PageName>/<Name>'` for page-local components, `parameters.layout`, an `args`-based `Default` story plus any meaningfully different variants/states the component actually supports).
   - Only cover props/variants the component actually exposes — don't invent states it doesn't have.

6. **Verify**: run the project's lint command on the touched files if feasible, and visually sanity-check the composed primitives' prop names against the actual files in `src/components/ui/` (don't guess prop names — read the primitive file first).

## Notes

- Brand-specific visual variants of an existing primitive (e.g. custom-branded button colors/shapes) belong as extra `cva` variants inside the tier 1 primitive itself (`src/components/ui/button.tsx`'s `variant`/`shape`/`size` options), not as a separate wrapper component. Only create a new component when the thing being built has distinct markup/behavior, not just distinct styling of an existing primitive.
- Framework-generated route files (e.g. file-based routing directories) are managed by the router — don't create components there; components belong in `src/components/` or `src/pages/*/components/`.
- **Generalize before naming after a single use case.** When a new component's core interaction pattern (e.g. "a group of selectable cards") is likely to recur with different content (numbers, text labels, icons, etc.), build a general-purpose base component first (generic over its value type where relevant, e.g. `<TValue extends string | number>`), then build the specific use case as a thin preset on top of it. Don't name a component after its first concrete use case if the underlying pattern is reusable — name the base after the pattern, and let callers inject their own child content/labels into each option.
- TypeScript generic type parameters should be named `T` or `T<PascalCase>` (e.g. `TValue`, `TItem`) to stay compatible with common `@typescript-eslint/naming-convention` setups — plain names like `Value` often fail lint.
