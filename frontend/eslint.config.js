// Flat config for ESLint 10 + TypeScript + React.
//
// Migrated from eslint-plugin-react (legacy 7.x, peer-locked at eslint 9)
// to @eslint-react/eslint-plugin, the official successor that ships
// eslint-10-ready peers and a TypeScript-first ruleset. React-Hooks v7
// exposes the flat-config-shaped entry under `configs.flat.recommended`
// — the older `recommended-latest` still uses the legacy `plugins: []`
// array form which ESLint 10's flat loader rejects.
//
// Several rules from the new presets fire on patterns we use on purpose
// or that target a feature we don't have enabled (React Compiler). They
// are turned off in the project rule block below with one-line rationale
// each, instead of being shut off as a group, so a future compiler
// migration can re-enable them line by line.
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactX from "@eslint-react/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "*.config.ts",
      "vite.config.ts",
    ],
  },
  js.configs.recommended,
  reactX.configs["recommended-typescript"],
  reactHooks.configs.flat.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // --- React Compiler rules (new in react-hooks v7) -----------------
      // We don't run the React Compiler. These rules enforce its
      // invariants and fire on perfectly fine non-compiler code. Enable
      // them piecemeal once `babel-plugin-react-compiler` is wired up.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-render": "off",
      "react-hooks/unsupported-syntax": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/error-boundaries": "off",
      "react-hooks/gating": "off",
      "react-hooks/globals": "off",
      "react-hooks/config": "off",

      // --- @eslint-react duplicates / opinionated style ----------------
      // Duplicate of react-hooks/* — keep one source of truth.
      "@eslint-react/set-state-in-effect": "off",
      "@eslint-react/exhaustive-deps": "off",
      // Compiler-flavoured component-shape rules — see above.
      "@eslint-react/static-components": "off",
      "@eslint-react/no-nested-component-definitions": "off",
      // VLAN chips, port grids and other stable positional renders use
      // the index as the only sensible key — fabricating ids would just
      // hide the intent.
      "@eslint-react/no-array-index-key": "off",
      // Style preference; we don't enforce ref-naming conventions.
      "@eslint-react/naming-convention/use-state": "off",
      "@eslint-react/naming-convention/context-name": "off",
      "@eslint-react/naming-convention/component-name": "off",
      "@eslint-react/naming-convention/filename": "off",
      "@eslint-react/naming-convention/filename-extension": "off",
      "@eslint-react/naming-convention-ref-name": "off",

      // QR-Code SVG comes from our own backend (signed session) and is
      // the only intentional use of dangerouslySetInnerHTML in the app.
      "@eslint-react/dom-no-dangerously-set-innerhtml": "off",

      // Provider value identity is intentionally fresh per render in
      // contexts that surface live data; memoising would mask updates.
      "@eslint-react/no-unstable-context-value": "off",
      "@eslint-react/no-unstable-default-props": "off",
    },
  },
];
