#!/usr/bin/env node
// bin/pi-subagent-cli.mjs
//
// pi 引擎 CLI 入口（manifest bin）。加载顺序 dist-first（MF-5 修复，约束 C-proc-11）：
//   1. dist/main.js —— tsup 产物（pnpm build / CI 构建段产出）。npm 发布形态
//      （publishConfig + files 双形态约定，同 subagent-core D4）恒走这里；
//   2. src/main.ts —— 仅 workspace 开发形态回退：pnpm symlink 的 realpath 在
//      node_modules 外，node ≥23.6 原生 type-stripping 可加载 .ts。npm 安装形态
//      realpath 在 node_modules 内，Node 拒绝对其做 type-stripping——回退必然
//      失败，故该分支以 node_modules 路径段判据禁用，dist 缺失时输出可操作错误
//      （发现面 canExecute 只查 X_OK 位、派发期才真正加载本文件，坏形态必须在
//      入口显式失败，不允许静默走入注定炸的分支）。

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, "../dist/main.js");
const srcEntry = join(here, "../src/main.ts");

// dynamic import 只接受 URL：裸绝对路径在 Windows（盘符 `C:\...` 被解析成协议）
// 报 ERR_UNSUPPORTED_ESM_URL_SCHEME，必须经 pathToFileURL 转 file:/// URL。
if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href);
} else if (existsSync(srcEntry) && !here.split(/[\\/]/).includes("node_modules")) {
  await import(pathToFileURL(srcEntry).href);
} else {
  console.error(
    [
      `[pi-subagent-cli] engine entry not found: ${distEntry}`,
      "",
      "The installed package is missing its dist/ build output — a packaging",
      "defect of the installed version, not a local setup issue. Fix:",
      "  - npm install: reinstall a healthy published version",
      "    (npm i @zhushanwen/pi-subagent-cli@latest)",
      "  - workspace checkout: pnpm --filter @zhushanwen/pi-subagent-cli build",
    ].join("\n"),
  );
  process.exit(1);
}
