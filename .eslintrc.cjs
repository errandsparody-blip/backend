module.exports = {
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "tsconfig.json",
    tsconfigRootDir: __dirname,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "eslint-config-prettier",
  ],
  root: true,
  env: { node: true, jest: true },
  // `scripts/` and `prisma/` live outside tsconfig's `include` paths; they
  // run via ts-node directly. The project-aware parser would fail on them,
  // and the existing lint glob (`{src,test}/**/*.ts`) already skips them.
  ignorePatterns: [".eslintrc.cjs", "dist/**", "coverage/**", "scripts/**", "prisma/**"],
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/consistent-type-imports": "error",
    "no-console": ["warn", { allow: ["warn", "error"] }],
  },
};
