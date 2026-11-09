/* @pi-meta
name: merge
description: >-
  taiji 九阶段合并发布单 workflow：15 step 串行（含 rescue 兜底 agent 与机器分类路由），
  终态 released/failed/needs-squash-approval/needs-human。
  由 .agents/workflows/src/merge.shared.ts 单源生成（本文件为构建产物，勿手工维护；
  重建入口 node .agents/workflows/scripts/build-workflows.mjs）
when: zcode 之外的 pi 主 agent 执行 merge skill（含 pr-cr-fix-merge 第二段）的合并发布流程
notFor: 纯分支合并不发布、npm 预发布（prerelease skill 线）、非 taiji 仓库
phases: ['发起前检查', '初始化', 'commit 整理判定', '本地验证', 'Dev-Link 清理', 'PR CI 与合并', 'Post-merge CI', '版本校验', 'e2e 圈定', '版本 bump 与发布', 'npm 发布检测移交', 'Release Notes', '交付物复核', 'GitCode 镜像', '清理']
parameters:
  type: object
  properties:
    worktree:
      type: string
      description: feature worktree 绝对路径（必传，如 <workspace>/feat-xxx；不得为 main——阶段 7 会删除该 worktree）
    prNumber:
      type: integer
      description: PR 号（可选，缺省由 init.sh 输出取；skipSteps 含 init 时必传）
    squashMode:
      type: string
      enum: [auto, skip]
      description: commit 整理档位：auto（agent 判定，需整理停回出计划）/ skip（显式跳过），默认 auto
    maxRescueRounds:
      type: integer
      description: 单阶段 rescue 兜底修复轮次上限（0-5，0 = 不派 rescue agent），默认 2
    skipSteps:
      type: string
      description: 跳过的 step id，逗号分隔（人工接管逃生舱；合法值 preflight/init/squash-check/premerge/prune-devlink/pr-merge/post-merge-ci/version-check/e2e-select/bump-release/npm-detect/notes/verify/gitcode-sync/cleanup；squash-check 之外被跳过的 step 会触发清理门禁 needs-human）
    taskId:
      type: string
      description: 阶段观测任务 id（可选；与 executionId 同时给出才启用观测，缺省零行为差异）
    executionId:
      type: string
      description: 阶段观测执行 id（可选；与 taskId 同时给出才启用；事件落 ~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl）
    sampleType:
      type: string
      enum: [production, selftest]
      description: 观测事件采样标记（默认 production；自动化验证用 selftest）
usage: |
  ## 使用说明
  - 发起：workflow 工具 action=run + name=<本脚本绝对路径>，args 示例：worktree=<workspace>/feat-xxx squashMode=auto maxRescueRounds=2
  - worktree 必传且不得为 main；gh 已认证；main worktree 存在（<workspace>/main）
  - 终态 return：status=released（含 prUrl/tag/releaseUrl/stages/npmHandoff/rescues/nextAction）
    或 failed / needs-squash-approval / needs-human（含 failedStep/error/recovery）
  - 范围语义：0.5 需整理时停回出计划（主 agent 人工段整理后重新发起 + skipSteps 含 squash-check）；
    4N 检测到 extensions 改动时主链继续、移交主 agent 人工段；3.7 真机 e2e 默认只圈不跑
  - 恢复：failed 处置后重新发起 + skipSteps 跳过已完成 step（squash-check 之外被跳过会触发清理门禁）
*/

// ══ pi 壳（平台适配层）══
// 公共体（merge.shared.ts）以 zcode 原生形态书写：字面 agent( 调用 + ask<T> 泛型
// + world.run + report + artifact。构建管线（scripts/build-workflows.mjs）对公共体做
// 词法安全改写（agent( → wfAgent(、.ask<T>( → .ask("T", ）并剥离 TS 后在 @@STITCH@@ 处
// 拼入本壳；本段提供全部宿主注入物。生成物勿手工维护。

// ── $ARGS（平铺字符串）→ args 对象（zcode 形态）──
// 本层只做承载形态转换（字符串 → 对象/数字/数组）；白名单校验与类型 fail-fast 全部由
// 公共体参数段接管（单一权威，两平台同一套报错）。_runId 是 pi 引擎注入的内部字段，
// 不属于业务参数，不进 args。未知键同理交给公共体白名单报错。
const fs = require("fs");
const { spawn } = require("child_process");
const strArg = (v) => (typeof v === "string" ? v.trim() : "");
const splitList = (v) =>
  Array.isArray(v)
    ? v.map((s) => String(s).trim()).filter(Boolean)
    : String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const numArg = (v) => (typeof v === "number" ? v : /^\d+$/.test(strArg(v)) ? Number(strArg(v)) : v);
const args = {};
{
  const raw = $ARGS || {};
  if (raw.worktree !== undefined) args.worktree = strArg(raw.worktree);
  if (raw.prNumber !== undefined) args.prNumber = numArg(raw.prNumber);
  if (raw.squashMode !== undefined) args.squashMode = strArg(raw.squashMode);
  if (raw.maxRescueRounds !== undefined) args.maxRescueRounds = numArg(raw.maxRescueRounds);
  if (raw.skipSteps !== undefined && String(strArg(raw.skipSteps)) !== "") args.skipSteps = splitList(raw.skipSteps);
  if (raw.taskId !== undefined) args.taskId = strArg(raw.taskId);
  if (raw.executionId !== undefined) args.executionId = strArg(raw.executionId);
  if (raw.sampleType !== undefined) args.sampleType = strArg(raw.sampleType);
}

// ── 结构化返回 schema（公共体 ask<T> 的 T → 手写 JSON Schema；引擎 ajv 校验）──
const SCHEMA_BY_KEY = {
  RescueReport: {
    type: "object",
    required: ["action", "summary", "filesChanged", "residualRisk"],
    properties: {
      action: { type: "string", enum: ["fixed", "retry", "escalate"], description: "fixed = 已修复（流程将重跑原脚本验证）；retry = 未改动建议直接重跑；escalate = 不可自动修复" },
      summary: { type: "string", description: "修复/判定摘要" },
      filesChanged: { type: "array", items: { type: "string" }, description: "改动文件清单（供对账核对越权改动）" },
      residualRisk: { type: "string", description: "残留风险说明，无则空串" },
    },
  },
  SquashVerdict: {
    type: "object",
    required: ["action", "reason", "plan"],
    properties: {
      action: { type: "string", enum: ["no-need", "needs-squash", "uncertain"], description: "no-need = 粒度已合理放行；needs-squash = 确需整理（plan 必填）；uncertain = 拿不准按保留放行" },
      reason: { type: "string", description: "一句判定理由" },
      plan: { type: "string", description: "needs-squash 时必填：重组计划表（每行一笔：保留 / 折入 <目标> / 重写 message + 一句理由）；其余动作填空串" },
    },
  },
  NotesDraft: {
    type: "object",
    required: ["filePath", "summary"],
    properties: {
      filePath: { type: "string", description: "双语 notes 写入的文件绝对路径（必须等于任务书指定路径）" },
      summary: { type: "string", description: "一句内容摘要" },
    },
  },
};;

// ── agent 适配（wfAgent：zcode 链式形态 → pi callSpec 单发形态）──
// persona 参数拼进 prompt 头部（pi 引擎无独立 persona 槽）。ask 判别：第一参数命中
// SCHEMA_BY_KEY = typeKey 形态（带 schema 结构化返回）；否则整串是 prompt。
function parseResult(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function wfAgent(name, persona) {
  return {
    ask: async (typeKeyOrPrompt, maybePrompt) => {
      const hasSchema = typeof typeKeyOrPrompt === "string" && Object.prototype.hasOwnProperty.call(SCHEMA_BY_KEY, typeKeyOrPrompt);
      const prompt = hasSchema ? maybePrompt : typeKeyOrPrompt;
      const callSpec = { prompt: persona + "\n\n" + prompt, description: name, model: $MODEL, returnMeta: true };
      if (hasSchema) callSpec.schema = SCHEMA_BY_KEY[typeKeyOrPrompt];
      const raw = await agent(callSpec);
      if (raw && typeof raw === "object" && raw.error) {
        throw new Error(name + " 调用失败： " + raw.error);
      }
      const parsed = parseResult(raw && typeof raw === "object" && "value" in raw ? raw.value : raw);
      if (!parsed) {
        throw new Error(name + " 返回无效（无法解析为结构化对象）： " +
          String(typeof raw === "object" ? JSON.stringify(raw.value ?? raw) : raw).slice(0, 200));
      }
      return parsed;
    },
  };
}

// ── 子进程包装（zcode world.run 同构返回）。async spawn + POSIX 进程组（detached）：
// 发布脚本会派生 pnpm/vitest/curl 子树，spawnSync 超时只杀直接子进程会留孤儿——超时
// 必须整组 kill；async 化同时让 worker 事件循环在长等待期间可处理 abort 消息。
// ENOENT（命令不在 PATH）归一为「exit 2 工具错误」约定 + [cmd-missing] stderr 标记。
// abort 边界（引擎能力缺口，脚本侧无法回收）：abort/terminate 只杀 worker 线程，
// 不通知本脚本——detached 子树会继续跑完；重发起前人工确认无残留。
const CMD_MISSING = "[cmd-missing]";
function killGroup(child, sig) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // 进程/组已退出
  }
}
// 子进程缺省墙钟 2h（git commit 的 pre-commit 全套钩子分钟级，CI 等待段由调用点显式传）
const DEFAULT_RUN_TIMEOUT_MS = 7_200_000;
function runCmd(cmd, argsArr, timeoutMs = DEFAULT_RUN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argsArr, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", // POSIX：子进程任组长，超时可整组 kill
    });
    // 64MB 上限：滚动保留**末段**——诊断消费方全部用 tailLines 取尾，截断保头会让
    // 错误摘要点位失效
    const cap = 64 * 1024 * 1024;
    const collect = (chunksRef) => {
      const chunks = chunksRef.chunks;
      return (d) => {
        chunks.push(d);
        chunksRef.len += d.length;
        while (chunksRef.len > cap) {
          chunksRef.len -= chunks[0].length;
          chunks.shift();
          chunksRef.truncated = true;
        }
      };
    };
    const outRef = { chunks: [], len: 0, truncated: false };
    const errRef = { chunks: [], len: 0, truncated: false };
    child.stdout.on("data", collect(outRef));
    child.stderr.on("data", collect(errRef));
    let timedOut = false;
    const timeoutNote = (t) => t
      ? "\n[timeout] 子进程超时被终止（整进程组：" + cmd + " " + argsArr.join(" ") + "）"
      : "";
    const truncateNote = (ref, label) => (ref.truncated ? "\n[truncated] " + label + " 超 64MB，仅保留末段" : "");
    let timer = null;
    let killer = null;
    let forceSettle = null;
    const settle = (exitCode, extraStderr) => {
      if (timer) clearTimeout(timer);
      if (killer) clearTimeout(killer);
      if (forceSettle) clearTimeout(forceSettle);
      resolve({
        exitCode,
        stdout: Buffer.concat(outRef.chunks).toString("utf-8"),
        stderr: Buffer.concat(errRef.chunks).toString("utf-8") +
          truncateNote(outRef, "stdout") + truncateNote(errRef, "stderr") + (extraStderr || ""),
      });
    };
    if (typeof timeoutMs === "number") {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, "SIGTERM");
        killer = setTimeout(() => killGroup(child, "SIGKILL"), 10_000); // 顽固子树宽限后强杀
        // 兜底回收：孙进程若 setsid 脱离进程组且继承 stdout 写端，close 事件永不触发
        // （父进程持有读端）——SIGKILL 宽限后再等 15s 强制 settle，杜绝无限挂起
        forceSettle = setTimeout(() => {
          killGroup(child, "SIGKILL");
          settle(124, timeoutNote(true) + "\n[force-settle] 进程组回收超时强制返回（孙进程可能脱离进程组存活，人工核查残留进程）");
        }, timeoutMs + 15_000);
      }, timeoutMs);
    }
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        settle(2, CMD_MISSING + " 命令不存在: " + cmd + "（不在 PATH）——安装该命令后重新发起\n");
      } else {
        settle(1, "[spawn-error] " + String(err && err.message ? err.message : err) + "\n");
      }
    });
    child.on("close", (code) => {
      // timedOut 强制 124：子树捕获 SIGTERM 后以 exit 0 退出的形态不得记 PASS
      settle(timedOut ? 124 : (code === null ? 1 : code), timeoutNote(timedOut));
    });
  });
}

// ── 其余宿主注入物（zcode 通道 → pi 等价物）──
const world = {
  run: (cmd, argsArr, opts) =>
    runCmd(cmd, argsArr, opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined),
};
const files = {
  read: async (p) => fs.readFileSync(p, "utf-8"),
};
const report = (obj) => log("[report] " + JSON.stringify(obj));
const artifact = {
  // pi 无终态摘要卡片通道：return 值经 notifyDone 直达主 agent，摘要走 log
  markdown: async (_name, content) => { log(content); },
};

// ── 阶段观测平台钩子（O 区；公共观测层 observability.shared.ts 经构建器拼入本产物，
// 业务正文只声明阶段边界）──
// 事件契约与落盘路径由公共层单一承载；本壳只提供两个平台钩子：obsNow（pi worker 内直取，
// 无 journal 重放语义——每次 run 实写）与 obsAppend（fs 直写）。观测为辅助通道：写失败
// 由公共层统一告警（同文件一次）不改业务终态（与 zcode 壳同契约）。
async function obsNow() {
  return new Date().toISOString();
}
async function obsAppend(filePath, line) {
  try {
    fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line + "\n");
    return null;
  } catch (e) {
    return e && e.message ? e.message : String(e);
  }
}

@@STITCH@@
