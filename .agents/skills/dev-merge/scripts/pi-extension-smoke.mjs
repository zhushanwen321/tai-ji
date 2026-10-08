#!/usr/bin/env node
// pi-extension-smoke.mjs — dev-merge gate：把当前 worktree 全部 pi extension 源码入口经
// pi 真实加载一次的启动冒烟。背景：extension 包的 package.json main 指向错文件 / 入口
// import 链上有加载期即崩的问题时，装进 pi 宿主才暴露（报 "Failed to load extension"）；
// 本 gate 在合并前用本地源码路径直接复现该失败。
//
// 机制（零 LLM 调用）：pi 非交互模式下 extension 加载发生在模型会话创建之前（pi main.js
// 实装顺序：加载 extension → 失败即 exit 1 → createAgentSession）。--mode rpc + stdin
// EOF = 加载全部 extension 后立即干净退出（exit 0），不触达模型。
//
// 捞取规则：extensions/{taiji,universal}/ 二级目录含 package.json 者为 extension 包
// （一级散落的空目录是旧结构残留，git 不跟踪），入口 = package.json main 字段相对路径。
// extensions/shared/ 整组排除——它是共享库组（被其他 extension import 的依赖，入口无
// pi extension 要求的 factory export，直接加载必报 invalid factory，2026-10-08 全组实测）。
//
// 用法（cwd 必须在待合并 feat worktree 根目录，对齐 dev-merge SKILL 调用约束）：
//   node .agents/skills/dev-merge/scripts/pi-extension-smoke.mjs           # 人类可读输出
//   node .agents/skills/dev-merge/scripts/pi-extension-smoke.mjs --json    # stdout 输出 JSON
//
// 退出码：
//   0  全部入口加载成功（pass）；或 pi 未安装 / extension 包为 0（skip，理由见输出）
//   1  FAIL——存在加载失败的入口（failures 列明细）；修复后重跑本脚本验证
//   2  用法/环境错误（cwd 不在 extension 仓库内等）
//
// SKIP 语义：pi 未安装的宿主（如 CI）不阻塞流程，但必须显式披露，不静默跳过。

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EXT_GROUPS = ["extensions/taiji", "extensions/universal"];
const FAIL_MARK = "Failed to load extension";
const PI_TIMEOUT_MS = 120_000;

function collectEntries(root) {
  const entries = [];
  const skipped = [];
  const failures = [];
  for (const group of EXT_GROUPS) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) {
      skipped.push({ name: group, reason: "组目录不存在（分支差异），跳过" });
      continue;
    }
    for (const dir of readdirSync(groupDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const pkgPath = join(groupDir, dir.name, "package.json");
      if (!existsSync(pkgPath)) continue; // 无 package.json 的空目录（旧结构残留）不属 extension
      let main;
      try {
        main = JSON.parse(readFileSync(pkgPath, "utf8")).main;
      } catch (e) {
        failures.push({ entry: join(group, dir.name), error: `package.json 解析失败：${e.message}` });
        continue;
      }
      if (typeof main !== "string" || main === "") {
        skipped.push({ name: join(group, dir.name), reason: "package.json 无 main 字段，不构成可加载入口" });
        continue;
      }
      const entryPath = resolve(join(groupDir, dir.name), main);
      if (!existsSync(entryPath)) {
        failures.push({ entry: join(group, dir.name), error: `main 声明的入口不存在：${main}（声明指向缺失文件，pi 加载必失败）` });
        continue;
      }
      entries.push({ name: join(group, dir.name), path: entryPath });
    }
  }
  return { entries, skipped, failures };
}

function main() {
  const jsonMode = process.argv.includes("--json");
  const root = process.cwd();
  const say = (msg) => (jsonMode ? process.stderr : process.stdout).write(`${msg}\n`);

  if (!existsSync(join(root, "extensions"))) {
    console.error("ERROR: 当前目录下无 extensions/（cwd 必须在待合并 feat worktree 根目录）。恢复动作：cd <feat worktree 根> 后重跑");
    process.exit(2);
  }

  const { entries, skipped, failures } = collectEntries(root);
  for (const s of skipped) say(`SKIP: ${s.name} — ${s.reason}`);

  let status = "fail";
  let reason = "";
  if (failures.length > 0) {
    reason = "extension 包声明检查失败（main 指向缺失文件 / package.json 损坏）";
  } else if (entries.length === 0) {
    status = "skip";
    reason = "当前 worktree 无可加载的 extension 入口";
  } else {
    say(`>> pi --mode rpc -ne 加载 ${entries.length} 个 extension 入口（启动冒烟，零 LLM 调用）…`);
    const res = spawnSync("pi", ["--mode", "rpc", "-ne", ...entries.map((e) => ["-e", e.path]).flat()], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PI_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (res.error?.code === "ENOENT") {
      status = "skip";
      reason = "pi 未安装（PATH 中无 pi 命令），本机无 pi 宿主，跳过冒烟";
    } else if (res.error?.code === "ETIMEDOUT") {
      reason = `pi 启动超过 ${PI_TIMEOUT_MS / 1000}s 未退出（疑似 extension 挂起阻塞加载完成）`;
    } else {
      const stderr = res.stderr ?? "";
      const errLines = stderr.split("\n").filter((l) => l.includes(FAIL_MARK));
      if (errLines.length > 0) {
        reason = `pi 报告 ${errLines.length} 条 extension 加载失败：\n${errLines.join("\n")}`;
      } else if (res.status !== 0) {
        reason = `pi 退出码 ${res.status}（无 extension 加载错误，但启动异常）：\n${(stderr || (res.stdout ?? "")).split("\n").slice(-15).join("\n")}`;
      } else {
        status = "pass";
      }
    }
  }

  // failures 恒为数组：包声明问题列明细；pi 运行期失败（非包声明问题）为空数组，
  // 具体报错看 reason，不虚构条目
  const result = {
    status,
    reason: reason || undefined,
    entryCount: entries.length,
    skipped,
    failures,
  };
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  }
  if (status === "pass") {
    say(`OK: ${entries.length} 个 extension 入口全部加载成功`);
  } else if (status === "skip") {
    say(`SKIP: ${reason}（不阻塞，显式披露）`);
  } else {
    say(`FAIL: ${reason}`);
    if (failures.length > 0) say("修复上述包声明后重跑：node .agents/skills/dev-merge/scripts/pi-extension-smoke.mjs");
    process.exit(1);
  }
}

main();
