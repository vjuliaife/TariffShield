const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: "tariffshield/rules",
    rules: {
      // Allow explicit any — type assertions are used with untyped third-party libraries
      "@typescript-eslint/no-explicit-any": "off",
      // Allow non-null assertions — pool.query rows are typed and assertions are intentional
      "@typescript-eslint/no-non-null-assertion": "off",
      // Ignore parameters/variables/caught errors prefixed with underscore
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
];
