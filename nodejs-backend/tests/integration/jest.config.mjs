export default {
  clearMocks: true,
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.integration.test.ts'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript' },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
        sourceMaps: 'inline',
      },
    ],
  },
};
