import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Pins PI_CODING_AGENT_DIR to a temp dir so no suite can write fixture
    // credentials into the developer's real ~/.pi/agent state.
    setupFiles: ['./test/setup.ts'],
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
