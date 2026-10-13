import path from "node:path";

import { taijiTestConfig } from "../../../test-guard/factory.ts"

export default taijiTestConfig({
  test: {
    // tests/** 既有契约族 + src/__tests__/**（tool-declaration-slimming U-B1：
    // cross-package-contract 落 src/__tests__/，任务书 testCommand 字面路径）
    include: ["tests/**/*.test.ts", "src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // @earendil-works/pi-coding-agent 现从根 node_modules 解析（真实 SDK devDep），无需类型桩 alias
      // 测试环境用本地 mock，真实类型由 Pi 运行时提供
      "typebox": path.resolve(__dirname, "mocks/typebox.ts"),
    },
  },
});
