module.exports = {
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    // Allow explicit any — type assertions are used with untyped third-party libraries
    "@typescript-eslint/no-explicit-any": "off",
    // Allow non-null assertions — pool.query rows are typed and assertions are intentional
    "@typescript-eslint/no-non-null-assertion": "off",
    // Ignore parameters/variables prefixed with underscore
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
  },
};
