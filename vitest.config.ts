import { defineConfig } from 'vitest/config'

// Deliberately narrow. These tests cover the pure logic that has been verified
// by hand more than once across the last three sprints — the trip time model,
// the username rules, and the prose tightener. Anything needing a database or a
// browser is out of scope here; that is what the manual passes are still for.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
