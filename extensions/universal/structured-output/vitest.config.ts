import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default", "junit"],
    outputFile: { junit: "./test-results/vitest-junit.xml" },
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // @earendil-works/pi-coding-agent 现从根 node_modules 解析（真实 SDK devDep），无需类型桩 alias
      // 测试环境用本地 mock，真实类型由 Pi 运行时提供
      "typebox": path.resolve(__dirname, "mocks/typebox.ts"),
    },
  },
});
