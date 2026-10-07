// src/__tests__/dist-fresh.ts
//
// stale dist 防线（bin e2e 专用，beforeAll 调用）：bin/pi-subagent-cli.mjs 加载顺序
// dist-first——本地 worktree 的 dist 停在旧构建时，bin e2e 实际验证的是旧引擎代码
// （假红：断言的是旧行为，如 cwd 传导修复缺失；v0.10.14 轮实例，main worktree dist
// 停在月前旧构建）。CI 恒新构建不暴露，只有本地直跑踩中。
//
// 判据：src/**.ts 最新 mtime 超出 dist/main.js mtime 容差（5s，吸收 git checkout
// 同批写出的 mtime 抖动）即 fail-fast，附重建命令。

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function assertDistFresh(): void {
  const distEntry = join(PKG_ROOT, "dist", "main.js");
  if (!existsSync(distEntry)) {
    throw new Error("dist/main.js 不存在：先跑 pnpm --filter @zhushanwen/pi-subagent-cli build 再重跑本测试");
  }
  const distMtime = statSync(distEntry).mtimeMs;
  const FRESH_TOLERANCE_MS = 5_000;
  let newestSrc = 0;
  let newestSrcFile = "";
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        // __tests__ 不进 dist 产物（tsup 入口 = 生产源码）——改测试不触发重建要求
        if (name === "__tests__") continue;
        walk(p);
      } else if (name.endsWith(".ts") && st.mtimeMs > newestSrc) {
        newestSrc = st.mtimeMs;
        newestSrcFile = p;
      }
    }
  };
  walk(join(PKG_ROOT, "src"));
  if (newestSrc - distMtime > FRESH_TOLERANCE_MS) {
    throw new Error(
      `stale dist：dist/main.js 落后 src（最新 ${newestSrcFile}）——bin e2e 会验证旧引擎代码。` +
        "先跑 pnpm --filter @zhushanwen/pi-subagent-cli build 再重跑本测试",
    );
  }
}
