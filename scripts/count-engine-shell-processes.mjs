#!/usr/bin/env node
// scripts/count-engine-shell-processes.mjs
//
// pi-workflow-run-resource-model U2 交付：引擎宿主薄壳（pi-subagent-cli 形态）的
// 存活实例计数——A1/A3 验收的 ps 计数回落判定面（设计 §4.1 V1/V3，评审 F4 前置）。
//
// 特征串权威源（从 spawn 参数实装读取，非记忆）：
// - `pi-subagent-cli`：引擎 CLI bin basename（packages/pi-subagent-cli/package.json
//   `bin: { "pi-subagent-cli": "bin/pi-subagent-cli.mjs" }`）。spawn 链实装 =
//   engine-inspect-package.ts buildManifestCliDescriptor（descriptor.command = 解析后
//   bin 绝对路径）→ engine-client.ts spawnAndInitialize → resolveEngineNodeLaunch →
//   `spawn(<executor>, [<entryPath>, ...])`：进程 argv 携带 bin 路径——dev 形态
//   `node_modules/.bin/pi-subagent-cli` 或直跑 `bin/pi-subagent-cli.mjs`。
// - `/engines/`：打包态 staged 引擎 bundle 目录段（scripts/bundle-extensions.mjs
//   ENGINES_STAGED_ROOT = apps/electron/resources/engines/<id>/index.js，经
//   electron-builder extraResources 随包安装）。两特征与 e2e/batch-s4-abort-no-orphan.
//   spec.ts 头注（:36-40）的引擎宿主特征集逐字同源。
//
// 判定 = 命令行含任一特征（并集，s4 spec / 设计 V1 口径）。注意并集口径下 zcode 的
// staged 薄壳（/engines/zcode/）也计入——A1/A3 用「派发前基线 → 终态后复测」的差分
// 判定，环境内常驻引擎薄壳（zcode 懒加载单例）被基线吸收；测试进程 cmdline 含仓内
// pi-subagent-cli 路径的噪声同理被差分吸收。
//
// 用法：
//   node scripts/count-engine-shell-processes.mjs               # 输出 JSON 计数
//   node scripts/count-engine-shell-processes.mjs --self-test   # 特征匹配自测（离线，不依赖进程表）
//
// 输出 JSON：{ count, features, processes: [{pid, command, matchedFeatures}], platform, scannedAt }
// 仅 POSIX（ps 进程表；s4 spec 同款姿态）；Windows 无验收通路，报结构化错误。

import { execFileSync } from "node:child_process";

/** 引擎宿主薄壳特征集（权威源见文件头注释；新增引擎形态先改 spawn 实装再改此处）。 */
const SHELL_FEATURES = [
  { id: "cli-bin-name", pattern: "pi-subagent-cli" },
  { id: "staged-engines-dir", pattern: "/engines/" },
];

/**
 * 单条命令行的特征匹配（--self-test 的被测本体：纯函数，无 IO；模块私有——
 * 自包含工具脚本不外露函数面，行为验证走 --self-test 断言通道）。
 * @returns {string[]} 命中的特征 id 清单（空数组 = 非引擎宿主薄壳）。
 */
function matchEngineShellFeatures(command) {
  return SHELL_FEATURES.filter((f) => command.includes(f.pattern)).map((f) => f.id);
}

/**
 * 读取进程表并筛出引擎宿主薄壳（模块私有——IO 面依赖真实进程表，不经 vitest 直测；
 * 行为验证走 emitCount 实跑 + --self-test 特征断言）。
 * @returns {Array<{pid: number, command: string, matchedFeatures: string[]}>}
 */
function listEngineShellProcesses() {
  if (process.platform === "win32") {
    throw new Error(
      "count-engine-shell-processes: Windows is not supported (ps-based process table). " +
        "Recovery: run the A1/A3 process-count acceptance on macOS/Linux.",
    );
  }
  const out = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
  const selfPid = process.pid;
  const processes = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const sep = trimmed.indexOf(" ");
    if (sep <= 0) continue;
    const pid = Number.parseInt(trimmed.slice(0, sep), 10);
    if (!Number.isFinite(pid) || pid === selfPid) continue;
    const command = trimmed.slice(sep + 1).trim();
    const matchedFeatures = matchEngineShellFeatures(command);
    if (matchedFeatures.length > 0) {
      processes.push({ pid, command, matchedFeatures });
    }
  }
  return processes;
}

function emitCount() {
  const processes = listEngineShellProcesses();
  const result = {
    count: processes.length,
    features: SHELL_FEATURES.map((f) => f.pattern),
    processes,
    platform: process.platform,
    scannedAt: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/**
 * 特征匹配 fixtures（--self-test 断言清单）。
 * @type {Array<{command: string, expect: string[]}>}
 */
const SELF_TEST_FIXTURES = [
  // dev：.bin symlink 直解形态（descriptor.command = 解析后 bin 绝对路径）
  { command: "node /repo/node_modules/.bin/pi-subagent-cli", expect: ["cli-bin-name"] },
  // dev：bin 入口直跑形态
  { command: "node /repo/packages/pi-subagent-cli/bin/pi-subagent-cli.mjs", expect: ["cli-bin-name"] },
  // 打包态：staged 引擎 bundle（<app>/resources/engines/<id>/index.js）
  {
    command:
      "/Applications/TaiJi.app/Contents/Resources/app.asar.unpacked/resources/engines/pi/index.js",
    expect: ["staged-engines-dir"],
  },
  // 并集口径：zcode staged 薄壳命中 /engines/（基线差分吸收，见文件头注释）
  {
    command:
      "/Applications/TaiJi.app/Contents/Resources/app.asar.unpacked/resources/engines/zcode/index.js",
    expect: ["staged-engines-dir"],
  },
  // 非 pi 薄壳：zcode dev bin（两特征均不命中）
  { command: "node /repo/node_modules/.bin/zcode-subagent-cli", expect: [] },
  // pi 任务孙进程（spawnEngineChild，argv = pi 引擎本体路径）：不命中薄壳特征
  { command: "node /usr/local/bin/pi --mode rpc --session-dir /tmp/x", expect: [] },
  // 本脚本自身：不命中
  { command: "node scripts/count-engine-shell-processes.mjs", expect: [] },
];

/** --self-test：已知进程形态 → 期望特征匹配（离线 fixture 断言，不依赖进程表）。 */
function selfTest() {
  const fixtures = SELF_TEST_FIXTURES;
  let failed = 0;
  for (const f of fixtures) {
    const actual = matchEngineShellFeatures(f.command);
    const ok =
      actual.length === f.expect.length && f.expect.every((id, i) => actual[i] === id);
    if (!ok) {
      failed += 1;
      process.stderr.write(
        `self-test FAIL\n  command: ${f.command}\n  expect:  [${f.expect.join(", ")}]\n  actual:  [${actual.join(", ")}]\n`,
      );
    }
  }
  if (failed > 0) {
    process.stderr.write(`self-test: ${failed}/${fixtures.length} fixtures failed\n`);
    process.exit(1);
  }
  process.stdout.write(`self-test: ${fixtures.length}/${fixtures.length} fixtures passed\n`);
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
} else if (args.length > 0) {
  process.stderr.write("Usage: node scripts/count-engine-shell-processes.mjs [--self-test]\n");
  process.exit(2);
} else {
  emitCount();
}
