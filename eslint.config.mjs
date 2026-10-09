import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

// ESLint 9 flat config. `eslint-config-next@16` ships a native flat-config
// array (`eslint-config-next/core-web-vitals`), so it's spread in directly —
// no `FlatCompat` bridge, which chokes on the config's circular plugin refs.
//
// This file replaces a legacy `.eslintrc.json` that ESLint 9 silently ignored:
// with no flat config present, `next/core-web-vitals` — and with it
// `react-hooks/rules-of-hooks` — never ran. That gap is how a conditional-hook
// bug shipped without lint catching it.
const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "drizzle/**",
      "data-pipeline/**",
      // Local Claude Code agent worktrees (gitignored); outdated copies still trip rules-of-hooks.
      ".claude/worktrees/**",
      // Generated at build time from GitHub Releases (scripts/generate-changelog.ts).
      "src/lib/changelog.data.ts",
    ],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      // Promote the Rules of Hooks to an error explicitly so a conditional or
      // after-early-return hook fails lint/CI rather than only surfacing as a
      // runtime "Rendered more hooks than during the previous render" crash.
      // This is THE rule that would have caught the bug behind this change.
      "react-hooks/rules-of-hooks": "error",

      // eslint-plugin-react-hooks@5.2 (pulled in by next@16's core-web-vitals)
      // ships the React Compiler lint rules. This codebase predates the
      // Compiler and trips ~170 of these; they're a separate adoption effort,
      // not correctness bugs, so keep them off until/unless the Compiler is
      // adopted. Re-enable incrementally then.
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/static-components": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/purity": "off",
      "react-hooks/no-deps-of-inline-callbacks": "off",
      "react-hooks/incompatible-library": "off",

      // Classic advisory rules — keep visible as warnings (they were never
      // enforced while the lint config was broken) without failing CI.
      "react-hooks/exhaustive-deps": "warn",
      "react/no-unescaped-entities": "warn",
    },
  },
  {
    // The PDF renderer's `<Image>` is `@react-pdf/renderer`'s, not an HTML
    // `<img>` — it paints into a PDF page and has no alt attribute to give.
    files: ["src/lib/pdf/**/*.tsx", "src/lib/pdfSummary.tsx"],
    rules: {
      "jsx-a11y/alt-text": "off",
    },
  },
];

export default eslintConfig;
