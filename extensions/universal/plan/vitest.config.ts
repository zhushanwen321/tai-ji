import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    reporters: ["default", "junit"],
    outputFile: { junit: "./test-results/vitest-junit.xml" },
    include: ["src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // @earendil-works/pi-coding-agent 现从根 node_modules 解析（真实 SDK devDep），无需类型桩 alias
      // 测试环境用本地 mock，真实类型由 Pi 运行时提供（与 pending-notifications 等包约定一致）
      "@earendil-works/pi-tui": path.resolve(dir, "mocks/pi-tui.ts"),
      "@earendil-works/pi-ai": path.resolve(dir, "mocks/pi-ai.ts"),
      "typebox": path.resolve(dir, "mocks/typebox.ts"),
    },
  },
});
