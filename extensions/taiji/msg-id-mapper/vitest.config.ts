import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    reporters: ["default", "junit"],
    outputFile: { junit: "./test-results/vitest-junit.xml" },
    include: ["src/__tests__/**/*.test.ts"],
    root: __dirname,
  },
});
