import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const ownedTypeScriptFiles = [
  'src/config/**/*.ts',
  'src/common/**/*.ts',
  'src/app/**/*.ts',
  'src/server.ts',
  'src/composition-root.ts',
  'jest.config.ts',
];

const scopeConfigs = (configs) =>
  configs.map((config) => ({ ...config, files: ownedTypeScriptFiles }));

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  ...scopeConfigs(tseslint.configs.strictTypeChecked),
  ...scopeConfigs(tseslint.configs.stylisticTypeChecked),
  {
    files: ownedTypeScriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
    },
  },
  {
    // Supertest response bodies are `any`; asserting on them is intentional in
    // tests and would otherwise trip the type-checked "unsafe" rules.
    files: [
      'src/app/**/*.test.ts',
      'src/app/**/*.spec.ts',
      'src/common/**/*.test.ts',
      'src/common/**/*.spec.ts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
