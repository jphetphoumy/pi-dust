import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'commitlint.config.cjs', 'eslint.config.js', 'vitest.config.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/dust-types.ts'],
      reporter: ['lcov', 'json-summary', 'text'],
      clean: true,
    },
  },
})
