/* @pi-meta
name: dev-merge-gates
description: >-
  dev-merge 的前置两步 workflow（gates + branch-review）。由
  .agents/workflows/src/dev-merge-gates.shared.ts 单源生成（本文件为构建产物，勿手工维护；
  重建入口 node .agents/workflows/scripts/build-workflows.mjs）。zcode 版同源 =
  .agents/workflows/dev-merge-gates.dwf.ts。
when: pi 主 agent 执行 dev-merge skill 第 1.6/1.7 步时发起（workflow 工具 action=run +
  name=<本脚本绝对路径>，从 <available_workflows> 清单的 location 取；发起前 cwd 必须已在
  待合并 feat worktree 根）
notFor: merge/cleanup 机械步骤（走 dev-merge.sh）与传播检查（dev-merge SKILL 第 1.8 步编排）
phases: ['质量门与 changeset 前置（gates，恒跑）', 'branch-review 审查修复循环（每轮重审活跃维度）', '聚合裁决（跨维度合并与修复分组）', '修复执行（分组修复 + 组级提交）']
parameters:
  type: object
  properties:
    base:
      type: string
      description: 分支增量基线 ref 名。缺省取 git merge-base github/main HEAD（fallback main，与 quality-gates.mjs --side dev-merge 的自解析口径一致）
    maxRounds:
      type: integer
      description: branch-review review→fix 循环轮次上限（1-50），默认 10
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
  - 发起前 cwd 必须已在待合并 feat worktree 根；发起前工作区必须全干净（tracked + untracked）
  - 发起：workflow 工具 action=run + name=<本脚本绝对路径>（取 <available_workflows> 清单的 location）
  - 终态 return：status=done（gates 与 branch-review 全绿，进 dev-merge 第 1.8 步传播检查）
    或 failed（failedStep/terminated/remaining/disputed/deferredCommits/recovery——按
    dev-merge SKILL 审查失败分级处置，打回级不进第 2 步合并）
*/

// ══ pi 壳（平台适配层）══
// 公共体（dev-merge-gates.shared.ts）以 zcode 原生形态书写：字面 agent( 调用 + ask<T> 泛型
// + world.run + report + artifact。构建管线（scripts/build-workflows.mjs）对公共体做词法
// 安全改写（agent( → wfAgent(、.ask<T>( → .ask("T", ）并剥离 TS 后在 @@STITCH@@ 处拼入
// 本壳；本段提供全部宿主注入物。生成物勿手工维护。

// ── $ARGS（平铺字符串）→ args 对象（zcode 形态）──
// 本层只做承载形态转换；白名单校验与类型 fail-fast 全部由公共体参数段接管（单一权威，
// 两平台同一套报错）。_runId 是 pi 引擎注入的内部字段，不属于业务参数，不进 args。
const fs = require("fs");
const { spawn } = require("child_process");
const strArg = (v) => (typeof v === "string" ? v.trim() : "");
const args = {};
{
  const raw = $ARGS || {};
  if (raw.base !== undefined) args.base = strArg(raw.base);
  if (raw.maxRounds !== undefined) {
    args.maxRounds = typeof raw.maxRounds === "number"
      ? raw.maxRounds
      : /^\d+(\.\d+)?$/.test(strArg(raw.maxRounds)) ? Number(strArg(raw.maxRounds)) : raw.maxRounds;
  }
  if (raw.taskId !== undefined) args.taskId = strArg(raw.taskId);
  if (raw.executionId !== undefined) args.executionId = strArg(raw.executionId);
  if (raw.sampleType !== undefined) args.sampleType = strArg(raw.sampleType);
}

// ── 结构化返回 schema（公共体 ask<T> 的 T → 手写 JSON Schema；引擎 ajv 校验）──
// 与公共体接口逐一对应（引擎从类型合成 schema 的 pi 侧手写等价物；改接口须同步）。
const SCHEMA_BY_KEY = {
  ReviewerVerdict: {
    type: "object",
    required: ["reportFile", "mustFix", "suggestion", "issues"],
    properties: {
      reportFile: { type: "string", description: "报告文件路径（workspace 相对）" },
      mustFix: { type: "number", description: "critical+major 数（必须与 issues 一致——只数 issues 数组即本轮新发现，对账未清条目经 reconciliation 申报、不重复计数）" },
      suggestion: { type: "number", description: "minor 数（必须与 issues 一致，口径同 mustFix）" },
      issues: {
        type: "array",
        description: "本轮（新）发现清单；无发现返回空数组；上轮清单条目不得写进 issues（只能经 reconciliation 申报）",
        items: {
          type: "object",
          required: ["title", "severity", "files", "evidence", "guidance"],
          properties: {
            title: { type: "string", description: "一行问题标题（跨轮身份锚点）" },
            severity: { type: "string", enum: ["critical", "major", "minor"] },
            files: { type: "array", items: { type: "string" }, description: "涉及文件路径（≥1，证据锚点）" },
            evidence: { type: "string", description: "证据（file:line + 你亲自读到的事实）" },
            guidance: { type: "string", description: "一句修复方向" },
          },
        },
      },
      reconciliation: {
        type: "array",
        description: "仅 R2+ 必填：上轮问题清单逐条申报，缺条 = review-failure",
        items: {
          type: "object",
          required: ["prevId", "status"],
          properties: {
            prevId: { type: "string", description: "上轮问题清单条目 id（全局编号 dmg-r<轮>-<序号>）" },
            status: {
              type: "string",
              enum: ["fixed", "not-fixed", "regressed", "escalate", "dispute-upheld", "dispute-overturned"],
              description: "fixed = 亲自核实已修复；not-fixed = 仍存在；regressed = 复发或修复引入新问题；escalate = deferred 条目相关上下文被本轮修复改变，申报复活；dispute-upheld / dispute-overturned = fixer 申述核实裁决（维持 finding 或撤销 finding）",
            },
            evidence: { type: "string", description: "读了什么、确认了什么；修复方声称 fixed 不算证据；dispute 两态同样须附亲自核实的依据" },
          },
        },
      },
    },
  },
  Aggregation: {
    type: "object",
    required: ["reportFile", "issues", "groups"],
    properties: {
      reportFile: { type: "string", description: "聚合报告路径（workspace 相对，<runDir>/round-<n>/aggregated.md）" },
      issues: {
        type: "array",
        description: "本轮合并裁决后的全部问题清单（延续复用 id，新问题不填 id）",
        items: {
          type: "object",
          required: ["title", "severity", "files", "evidence", "guidance", "adjudication"],
          properties: {
            id: { type: "string", description: "延续上轮的条目必填（复用原 id）；新条目不填（workflow 统一分配 dmg-r<轮>-<序号>）" },
            title: { type: "string", description: "一行问题标题（跨轮身份锚点）" },
            severity: { type: "string", enum: ["critical", "major", "minor"] },
            files: { type: "array", items: { type: "string" }, description: "涉及文件路径" },
            evidence: { type: "string", description: "证据（文件/行/你亲自读到的事实）" },
            guidance: { type: "string", description: "一句修复方向" },
            adjudication: { type: "string", enum: ["evidence", "unverified", "downgraded"], description: "evidence = 有真实代码证据进修复队列；unverified/downgraded 只进聚合报告与披露清单供人复核" },
            note: { type: "string", description: "unverified/downgraded 时必填裁决原因" },
            sourceDims: { type: "array", items: { type: "string" }, description: "来源维度清单（跨维度合并条目列全部来源维度，首个为主维度）" },
          },
        },
      },
      groups: {
        type: "array",
        description: "修复分组：每组可独立派 agent 修复（组内相关、组间文件不相交）；无 evidence 条目时返回空数组",
        items: {
          type: "object",
          required: ["id", "issueIds", "files", "note"],
          properties: {
            id: { type: "string", description: "组标识（G1、G2…，报告与日志引用）" },
            issueIds: { type: "array", items: { type: "string" }, description: "组内问题 id（必须是本轮 open 条目 id）" },
            files: { type: "array", items: { type: "string" }, description: "组涉及的文件（组间必须不相交，workflow 会确定性校验并合并相交组）" },
            note: { type: "string", description: "一句话分组依据（同文件/同模块/同根因）" },
          },
        },
      },
    },
  },
  FixReport: {
    type: "object",
    required: ["fixes", "disputed", "deferred", "commitMessage"],
    properties: {
      fixes: {
        type: "array",
        description: "已修复条目（id 引用问题清单，affectedFiles 供工作流统一 commit；申报只置 fix-claimed，下轮对账核实后才 fixed）",
        items: {
          type: "object",
          required: ["id", "description", "affectedFiles"],
          properties: {
            id: { type: "string", description: "问题 id（与任务文档中一致，原样引用）" },
            description: { type: "string", description: "一句修复描述" },
            affectedFiles: { type: "array", items: { type: "string" }, description: "改动文件 + 核对过的关联文件" },
          },
        },
      },
      disputed: {
        type: "array",
        description: "申述（误报反证，evidence 须含 file:line 且有实质内容）；下轮 reviewer 对账亲自核实（维持→回 open 修复，反证成立→撤销关闭 no-fix；至多两轮，穷尽才升人工）",
        items: {
          type: "object",
          required: ["id", "evidence"],
          properties: {
            id: { type: "string" },
            evidence: { type: "string" },
          },
        },
      },
      deferred: {
        type: "array",
        description: "仅 minor 可延迟（reason 须写明改动量与涉及文件——仅当改动量非常大时才允许）；critical/major 延迟 = fix-failure",
        items: {
          type: "object",
          required: ["id", "reason"],
          properties: {
            id: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
      commitMessage: { type: "string", description: "工作流统一 commit 的 message" },
    },
  },
  CommitReport: {
    type: "object",
    required: ["groups"],
    properties: {
      groups: {
        type: "array",
        description: "逐组提交执行结果；committed=false 时 errorKind 必填 env|content|blocked 之一且 errorDetail 必填报错原文（≤4000 字符）",
        items: {
          type: "object",
          required: ["group", "committed", "errorKind", "errorDetail"],
          properties: {
            group: { type: "string", description: "组标识（与提交计划一致）" },
            committed: { type: "boolean", description: "该组是否提交成功" },
            errorKind: { type: "string", enum: ["none", "env", "content", "blocked"], description: "committed=true → none；否则必填 env（环境恢复可解）/ content（恢复需改仓库内文件）/ blocked（不可修复）之一" },
            errorDetail: { type: "string", description: "报错原文（content 类补修与 blocked 类呈报都依赖原文，摘要语义不够）" },
          },
        },
      },
      envActions: { type: "array", items: { type: "string" }, description: "执行过的环境恢复动作（无则空数组），逐条「做了什么、为什么」——随披露清单带出" },
    },
  },
  CommitRepairReport: {
    type: "object",
    required: ["repairedFiles", "note"],
    properties: {
      repairedFiles: { type: "array", items: { type: "string" }, description: "补修涉及的全部文件（workflow 与修复前后 git status 增量交叉验证，不一致以实际为准并披露）" },
      note: { type: "string", description: "一句补修说明" },
    },
  },
  ChangesetVerdict: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["draft", "no-release"], description: "draft = 已写入并 commit changeset 文件；no-release = 全部为非发布改动" },
      files: { type: "array", items: { type: "string" }, description: "已写入并 commit 的 .changeset/*.md 路径（action=draft 时必填）" },
      skipReasons: { type: "array", items: { type: "string" }, description: "逐包跳过理由（action=no-release 时必填，格式「包名: 原因 + 证据」）" },
    },
  },
};

// ── agent 适配（wfAgent：zcode 链式形态 → pi callSpec 单发形态）──
// persona 参数拼进 prompt 头部（pi 引擎无独立 persona 槽）。ask 判别：第一参数命中
// SCHEMA_BY_KEY = typeKey 形态（带 schema 结构化返回）；ask<string> 的 "string" 不在表内
// = 无 schema 散文返回（环境恢复 agent 等回复即散文的调用落在此路）。
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
// gate 脚本会派生 pnpm/vitest 子树，超时必须整组 kill；async 化同时让 worker 事件循环
// 在长 gate 期间可处理 abort 消息。ENOENT 归一为「exit 2 工具错误」约定 + [cmd-missing]
// stderr 标记：gate 循环按 exit 2 不派修复 agent 空烧，调用方按标记给安装指引。
const CMD_MISSING = "[cmd-missing]";
function killGroup(child, sig) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // 进程/组已退出
  }
}
// 子进程缺省墙钟 2h（>1h）——git commit（pre-commit 全套钩子分钟级）等重子进程不再无界挂死
const DEFAULT_RUN_TIMEOUT_MS = 7_200_000;
function runCmd(cmd, argsArr, timeoutMs = DEFAULT_RUN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argsArr, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const cap = 64 * 1024 * 1024; // 滚动保留末段（诊断消费方全部用 tailLines 取尾）
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
        killer = setTimeout(() => killGroup(child, "SIGKILL"), 10_000);
        // 兜底回收：孙进程 setsid 脱离进程组且继承 stdout 写端时 close 永不触发
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
      settle(timedOut ? 124 : (code === null ? 1 : code), timeoutNote(timedOut));
    });
  });
}

// ── 其余宿主注入物（zcode 通道 → pi 等价物）──
const world = {
  run: (cmd, argsArr, opts) =>
    runCmd(cmd, argsArr, opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined),
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
