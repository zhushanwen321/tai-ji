/* @pi-meta
name: pr-lifecycle
description: >-
  taiji PR 全链生命周期单 workflow：9 step 门禁与条件评审修复循环，终态停在 push 授权前。
  由 .agents/workflows/src/pr-lifecycle.shared.ts 单源生成（本文件为构建产物，勿手工维护；
  重建入口 node .agents/workflows/scripts/build-workflows.mjs）
when: zcode 之外的 pi 主 agent 执行 pr-cr-fix skill 的完整 PR 生命周期
notFor: 只跑 review+fix 循环不进门禁不开 PR 的场景（用内置 review-fix-loop）与非 taiji 仓库
phases: ['发起前检查', '静态门禁', 'PR 元数据起草与 changeset 复核', '约束加载与覆盖率/度量门禁', '条件评审修复循环', '并行多维审查（4 个一批）', '聚合去重与修复分组', '分组并行修复（3 个一批）', '代码简化', '终局三道门禁']
parameters:
  type: object
  properties:
    base:
      type: string
      description: 审查/门禁基线 ref 名（git diff base...HEAD；gate 脚本对该值做文本比对，传 ref 名不传 hash），默认 main
    maxRounds:
      type: integer
      description: cr-fix review→fix 循环轮次上限（1-50），默认 10
    reviewers:
      type: string
      description: review 维度白名单，逗号分隔（对 .agents/skills/dev-merge/agents/review-*.md 按路径子串匹配裁剪；资产所有权归 dev-merge，本流程仅经此显式逃生舱引用）；缺省不传 = cr-fix 代码审查维度不派（默认，与分支无关）；显式传入 = 按白名单派发审查
    simplifyMode:
      type: string
      enum: [apply, report]
      description: code-simplify 档位：apply（A 档高置信项自动改码并独立 commit）/ report（只产报告不改码），默认 apply
    skipSteps:
      type: string
      description: 跳过的 step id，逗号分隔（人工接管逃生舱；合法值 preflight/static-gate/pr-meta/pr-submit/constraints/gate-suite/cr-fix/simplify/final-gates，终态逐项披露）
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
  - 必须在 taiji 仓库根（git rev-parse --show-toplevel）发起；gh 认证 + fallow 全局安装为 preflight 前置
  - 发起：workflow 工具 action=run + name=<本脚本绝对路径>（取 <available_workflows> 清单的
    location——按名解析已退役，裸名 not_found），args 示例：base=main maxRounds=10 simplifyMode=apply
  - 发起前披露义务：simplifyMode 默认 apply——code-simplify 的「先报告、确认后改」的人工确认环节被显式覆盖，
    A 档（行为不变）高置信简化会在 push 授权之前自动改码并独立 commit；用户不接受时传 simplifyMode=report
  - 终态 return：status=awaiting-push（成功，含 prUrl/terminated/simplify/gates/review/skippedSteps/nextAction）
    或 failed（含 failedStep/error/recovery）；push 需用户授权，主 agent 披露后请求确认
*/

// ══ pi 壳（平台适配层）══
// 公共体（pr-lifecycle.shared.ts）以 zcode 原生形态书写：字面 agent( 调用 + ask<T> 泛型
// + world.run + files.read + report + artifact。构建管线（scripts/build-workflows.mjs）
// 对公共体做词法安全改写（agent( → wfAgent(、.ask<T>( → .ask("T", ）并剥离 TS 后在
// @@STITCH@@ 处拼入本壳；本段提供全部宿主注入物。生成物勿手工维护。

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
const args = {};
{
  const raw = $ARGS || {};
  if (raw.base !== undefined) args.base = strArg(raw.base);
  if (raw.maxRounds !== undefined) {
    const n = typeof raw.maxRounds === "number" ? raw.maxRounds : /^\d+(\.\d+)?$/.test(strArg(raw.maxRounds)) ? Number(strArg(raw.maxRounds)) : raw.maxRounds;
    args.maxRounds = n;
  }
  if (raw.worktree !== undefined) args.worktree = strArg(raw.worktree);
  if (raw.reviewers !== undefined && String(strArg(raw.reviewers)) !== "") args.reviewers = splitList(raw.reviewers);
  if (raw.simplifyMode !== undefined) args.simplifyMode = strArg(raw.simplifyMode);
  if (raw.skipSteps !== undefined && String(strArg(raw.skipSteps)) !== "") args.skipSteps = splitList(raw.skipSteps);
  if (raw.taskId !== undefined) args.taskId = strArg(raw.taskId);
  if (raw.executionId !== undefined) args.executionId = strArg(raw.executionId);
  if (raw.sampleType !== undefined) args.sampleType = strArg(raw.sampleType);
}

// ── 结构化返回 schema（公共体 ask<T> 的 T → 手写 JSON Schema；引擎 ajv 校验）──
const SCHEMA_BY_KEY = {
  ReviewerVerdict: {
  type: "object",
  required: ["reportFile", "mustFix", "suggestion", "reconciliation"],
  properties: {
    reportFile: { type: "string", description: "报告文件路径（绝对路径，<runDir>/round-<n>/review-<dimension>.md）" },
    mustFix: { type: "number", description: "critical+major 数（与报告一致）" },
    suggestion: { type: "number", description: "minor 数" },
    problems: {
      type: "array",
      description: "逐条问题清单（分析落盘用，不参与计数与控制流）：条数合计须等于 mustFix+suggestion；缺失按空数组处理不 fail（向后兼容）",
      items: {
        type: "object",
        required: ["ref", "level", "title"],
        properties: {
          ref: { type: "string", description: "报告内问题节锚点（review-<维度>#<序>，行序即序号）" },
          level: { type: "string", enum: ["critical", "major", "minor"], description: "与报告分级一致" },
          title: { type: "string", description: "一句话问题标题" },
        },
      },
    },
    reconciliation: {
      type: "array",
      description: "R1 恒返回空数组 []；R2+ 对上一轮问题清单逐条申报",
      items: {
        type: "object",
        required: ["prevId", "status"],
        properties: {
          prevId: { type: "string", description: "上轮问题 id（R2+ 对账）" },
          status: {
            type: "string",
            enum: ["fixed", "not-fixed", "regressed", "escalate"],
            description: "fixed = 亲自核实已修复；not-fixed = 仍存在；regressed = 复发或修复引入新问题（计入修复失败）；escalate = deferred 条目上下文被本轮 fix 改变，申报复活（仅对 prompt 注入的 deferred 清单条目有效——deferral 的唯一复活入口，聚合重报不复活 deferred）",
          },
          evidence: { type: "string", description: "读了什么、确认了什么（file + 改动事实）；修复方声称 fixed 不算证据" },
        },
      },
    },
  },
},
  Aggregation: {
  type: "object",
  required: ["reportFile", "issues", "groups"],
  properties: {
    reportFile: { type: "string", description: "聚合报告路径（绝对路径）" },
    issues: {
      type: "array",
      description: "本轮合并裁决后的全部问题清单（延续复用 id，新问题不填 id）",
      items: {
        type: "object",
        required: ["title", "severity", "files", "evidence", "guidance", "adjudication"],
        properties: {
          id: { type: "string", minLength: 1, description: "延续上轮的问题必填（复用原 id，非空）；新问题按 MF-<轮>-<序号> 格式分配" },
          title: { type: "string", description: "一行问题标题（跨轮身份锚点）" },
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          files: { type: "array", items: { type: "string" }, description: "涉及文件路径" },
          evidence: { type: "string", description: "证据（文件/行/测试结果）" },
          guidance: { type: "string", description: "一句修复方向" },
          adjudication: { type: "string", enum: ["evidence", "unverified", "downgraded"], description: "evidence = 有代码证据进修复队列；unverified/downgraded 只进报告供人复核" },
          note: { type: "string", description: "unverified/downgraded 时必填裁决原因" },
          sourceRefs: {
            type: "array",
            description: "来源引用清单（分析落盘用）：[] = 本轮新发现；非空 = 上轮延续或多 reviewer 合并；缺失按空数组处理不 fail（向后兼容）",
            items: {
              type: "object",
              required: ["round", "ref"],
              properties: {
                round: { type: "number", description: "来源轮次（原问题首见轮或本轮）" },
                ref: { type: "string", description: "原问题 id 或来源 reviewer 报告锚点（如 review-<维度>#<序>）" },
              },
            },
          },
        },
      },
    },
    groups: {
      type: "array",
      description: "修复分组：每组可独立派 agent 修复；活跃问题为空时返回空数组",
      items: {
        type: "object",
        required: ["id", "issueIds", "files", "note"],
        properties: {
          id: { type: "string", description: "组标识（G1、G2…，报告与日志引用）" },
          issueIds: { type: "array", items: { type: "string" }, description: "组内问题 id（必须是本轮活跃 issue id）" },
          files: { type: "array", items: { type: "string" }, description: "组涉及的文件（组间必须不相交，workflow 会确定性校验并合并相交组）" },
          note: { type: "string", description: "一句话分组依据（同文件/同模块/同根因）" },
        },
      },
    },
  },
},
  CommitRepairReport: {
  type: "object",
  required: ["repairedFiles", "note"],
  properties: {
    repairedFiles: {
      type: "array",
      items: { type: "string" },
      description: "补修涉及的全部文件，不只报错点名文件——供对账核对越权改动（与修复前后 git status 增量交叉验证，不一致以实际为准并披露）",
    },
    note: {
      type: "string",
      description: "一句补修说明",
    },
  },
},
  FixOutcome: {
  type: "object",
  required: ["fixes", "disputed", "deferred", "commitMessage"],
  properties: {
    fixes: {
      type: "array",
      description: "已修复条目",
      items: {
        type: "object",
        required: ["issueId", "description", "selfCheck", "affectedFiles"],
        properties: {
          issueId: { type: "string", description: "问题 id（与任务文档中一致，原样引用）" },
          description: { type: "string", description: "一句修复描述" },
          selfCheck: { type: "string", description: "证明修复完整的自检：一条 grep 命令 + 预期结果" },
          affectedFiles: { type: "array", items: { type: "string" }, description: "改动文件 + 核对过的关联文件" },
        },
      },
    },
    disputed: {
      type: "array",
      description: "申述（claim）：fixer 怀疑误报，evidence 须含 file:line 反证；人类在 run 结束后裁决",
      items: {
        type: "object",
        required: ["issueId", "evidence"],
        properties: {
          issueId: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    deferred: {
      type: "array",
      description: "仅 minor 可延迟（reason 必须具体）；critical/major 禁止",
      items: {
        type: "object",
        required: ["issueId", "reason"],
        properties: {
          issueId: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    commitMessage: { type: "string", description: "未 commit 恒返回空串——工作流统一 commit" },
  },
},
  PrStageResult: {
  type: "object",
  required: ["title", "body"],
  properties: {
    title: { type: "string", description: "PR title，conventional commit 风格，英文" },
    body: { type: "string", description: "PR body 全文 markdown，英文" },
    changeset: {
      type: "object",
      description: "changeset 任务段被包含时必填",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["draft", "no-release"], description: "draft = 已写入 changeset 文件；no-release = 全部为非发布改动" },
        files: { type: "array", items: { type: "string" }, description: "已写入的 .changeset/*.md 路径（action=draft 时必填）" },
        skipReasons: { type: "array", items: { type: "string" }, description: "逐包跳过原因（action=no-release 时必填，格式「包名: 原因 + 证据」）" },
      },
    },
  },
},
  SimplifyResult: {
  type: "object",
  required: ["applied", "proposals"],
  properties: {
    applied: { type: "number", description: "已应用（A 档落地并 commit）的简化项数；report 模式恒 0" },
    proposals: { type: "number", description: "仅进报告未落地的提案数" },
  },
},
};;

// ── agent 适配（wfAgent：zcode 链式形态 → pi callSpec 单发形态）──
// persona 参数拼进 prompt 头部（pi 引擎无独立 persona 槽；与既有 pi 版 prompt 首段
// persona 文本形态一致）。ask 判别：第一参数命中 SCHEMA_BY_KEY = typeKey 形态（带
// schema 结构化返回）；否则整串是 prompt（无 schema 散文返回——gate 修复 agent /
// 环境恢复 agent 的 ask<string> 与无泛型 ask 都落在此路）。
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
// gate 脚本会派生 pnpm/vitest 子树，spawnSync 超时只杀直接子进程会留孤儿继续写
// .review/ 并与下一轮 gate 并发争资源——超时必须整组 kill；async 化同时让 worker
// 事件循环在长 gate 期间可处理 abort 消息。ENOENT（命令不在 PATH）归一为既有
// 「exit 2 工具错误」约定 + [cmd-missing] stderr 标记：gate 循环按 exit 2 不派
// 修复 agent 空烧，调用方按标记给安装指引。
// abort 边界（引擎能力缺口，脚本侧无法回收）：abort/terminate 只杀 worker 线程，
// 不通知本脚本——detached gate 子树会继续跑完（写 .review/）；重发起前人工确认
// 无残留（pgrep -f pr-pre-merge / coverage-gate / metrics-gate，见 SKILL.md 断点恢复节）。
const CMD_MISSING = "[cmd-missing]";
function killGroup(child, sig) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // 进程/组已退出
  }
}
// 子进程缺省墙钟 2h（>1h）——git commit（pre-commit 全套钩子分钟级）等重子进程不再
// 无界挂死，也防未来新增调用点漏传超时吃到隐性无界
const DEFAULT_RUN_TIMEOUT_MS = 7_200_000;
function runCmd(cmd, argsArr, timeoutMs = DEFAULT_RUN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argsArr, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", // POSIX：子进程任组长，超时可整组 kill
    });
    // 64MB 上限（对齐原 spawnSync maxBuffer）：滚动保留**末段**——诊断消费方全部
    // 用 tailLines 取尾，截断保头会让错误摘要点位失效
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
        // （父进程持有读端）——SIGKILL 宽限后再等 5s 强制 settle，杜绝 gate 无限挂起
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
