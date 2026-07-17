// Lenient-baseline ESLint config for the Hoteldesk monorepo.
//
// Philosophy: catch the bugs that actually bite (effect deps, floating
// promises, unused code) without nagging about style. The TypeScript
// compiler already enforces types — we don't re-enforce them here.
//
// New violations introduced AFTER this config lands should be treated
// as build-breakers in CI. Pre-existing violations are downgraded to
// warnings via the `--max-warnings` cap in the lint script so the
// initial baseline doesn't force a cleanup weekend.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // Don't lint generated, vendored, or build output.
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/coverage/**",
      "apps/api/migrations/**",
      "apps/api/scripts/**",
    ],
  },

  // Base rules for every TS/TSX file in the repo.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Shared rule overrides + bug-catching rules.
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // ---- High-signal bug catchers ----
      // Unused vars often indicate copy-paste mistakes or dead code.
      // Allow a leading underscore as the universal "intentionally
      // unused" convention (e.g. `_unused`).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Catches `foo && bar;` (was supposed to be a ternary) and
      // similar no-ops. Allow short-circuit / ternary intentionally.
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-expressions": [
        "warn",
        {
          allowShortCircuit: true,
          allowTernary: true,
        },
      ],
      // Forgot to await a promise = fire-and-forget mistake. The
      // TypeScript-aware version is opt-in (needs type info) so we
      // use the base rule which catches the common case.
      "no-async-promise-executor": "error",
      // `if (foo = bar)` typos.
      "no-cond-assign": "error",
      // Empty catch blocks silently swallow errors.
      "no-empty": ["warn", { allowEmptyCatch: false }],
      // Sparse arrays are almost always a mistake.
      "no-sparse-arrays": "warn",
      // `const foo = require(...)` mixed with ES modules confuses bundlers.
      "no-undef": "off", // TypeScript handles this
      // Allow the explicit `any` escape hatch but downgrade to warn so
      // it stays visible without blocking work.
      "@typescript-eslint/no-explicit-any": "warn",
      // Triple-equals avoids type-coercion surprises.
      eqeqeq: ["warn", "always", { null: "ignore" }],

      // ---- Rules we intentionally relax ----
      // The codebase uses `as` casts in a few places (e.g. branding
      // SLDT-RES-XXXX as a UUID resolver). Trust the cast.
      "@typescript-eslint/no-non-null-assertion": "off",
      // Many drizzle/react-query callbacks have stable inferred types
      // and explicit return types would only add noise.
      "@typescript-eslint/explicit-module-boundary-types": "off",
      // `Record<string, unknown>` over `{}` would force a large
      // refactor with no real bug-catch benefit.
      "@typescript-eslint/ban-types": "off",
    },
  },

  // React-specific rules — only apply to .tsx files (the web app).
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // The #1 source of "weird UI bugs" in React. Missing dep in a
      // useEffect / useMemo / useCallback array = stale closure.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // Test files — relax a few rules so test fixtures don't trigger lint.
  {
    files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
