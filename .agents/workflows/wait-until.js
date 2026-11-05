/* @pi-meta
name: wait-until
description: >-
  通用条件等待 workflow：参数化确定性检查原语（git-ancestor / dir-absent / dir-present /
  file-absent / file-present / file-contains）按间隔轮询，全部满足返回结构化报告，
  超时带终态停回。零 subagent 纯机器判定。由 .agents/workflows/src/wait-until.shared.ts
  单源生成（本文件为构建产物，勿手工维护；重建入口 node .agents/workflows/scripts/build-workflows.mjs）
when: 需要等待另一个会话/进程/后台任务完成机器可判定的落盘动作（合并落盘 / 清理 / 文件出现）后再继续
notFor: 需要语义判断的等待（模型判定场景请派 subagent）；观测参数 taskId/executionId 未接入（零 agent 无阶段归属）
phases: ['确认起点状态', '按间隔轮询，等待条件全部满足', '终态复核并汇总结果']
parameters:
  type: object
  properties:
    targetLabel:
      type: string
      description: 等待目标的一句中文描述（进结论文案与进度表标题；必填）
    checks:
      type: string
      description: 检查条件的 JSON 数组（字符串或对象数组均可）。每项 {"type":"..."}：git-ancestor{branch,target,gitDir?}（分支头已并入目标 ref，或分支已随收尾删除均算满足）/ dir-absent{path} / dir-present{path} / file-absent{path} / file-present{path} / file-contains{path,text}（text 为单行固定子串）
    pollSeconds:
      type: integer
      description: 轮询间隔秒数（≥5），默认 900 = 15 分钟
    maxRounds:
      type: integer
      description: 轮询轮数上限（≥1），默认 96（与默认间隔合 = 24 小时）
    cwd:
      type: string
      description: 检查命令的工作目录（可选；建议绝对路径。缺省 = 发起进程当前目录）
usage: |
  ## 使用说明
  - 发起：workflow 工具 action=run + name=<本脚本绝对路径>（取 <available_workflows> 清单的 location），
    args 平铺传参示例：targetLabel="dev-0.12.4 两线合并落盘"
    checks='[{"type":"git-ancestor","branch":"feat-x","target":"dev-0.12.4","gitDir":".bare"},{"type":"dir-absent","path":"feat-x"}]'
    pollSeconds=900 maxRounds=96 cwd=<workspace 根绝对路径>
  - 终态 return：全部条件满足 = 完成报告（conclusion/findings/verified/notCovered，可进入后续流程）；
    超时 = 带各条件终态的停回报告（被等待方可能卡在人工裁决环节）
  - 命令词表：全部判定经 bash 包装（git / test / grep / sleep），argv 传参无注入面
*/

// ══ pi 壳（平台适配层）══
// 公共体（wait-until.shared.ts）以 zcode 原生形态书写（world.run / report / artifact /
// phase / args），构建管线对公共体做词法安全改写并剥离 TS 后在 @@STITCH@@ 处拼入本壳。
// 本壳提供宿主注入物。生成物勿手工维护。
// 本 workflow 无 agent( 调用点（构建器 NO_AGENT 显式登记），故无 wfAgent/SCHEMA_BY_KEY。

// ── $ARGS（平铺字符串）→ args 对象（zcode 形态）──
// 只做承载形态转换；白名单校验与类型 fail-fast 全部由公共体参数段接管（单一权威，
// 两平台同一套报错）。_runId 是 pi 引擎注入的内部字段，不属于业务参数，不进 args。
const fs = require("fs");
const { spawn } = require("child_process");
const strArg = (v) => (typeof v === "string" ? v.trim() : "");
const numArg = (v) =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^\d+$/.test(v.trim())
      ? Number(v.trim())
      : v;
const args = {};
{
  const raw = $ARGS || {};
  if (raw.targetLabel !== undefined) args.targetLabel = strArg(raw.targetLabel);
  if (raw.checks !== undefined) args.checks = raw.checks; // 数组或 JSON 字符串原样传，公共体统一窄化
  if (raw.pollSeconds !== undefined) args.pollSeconds = numArg(raw.pollSeconds);
  if (raw.maxRounds !== undefined) args.maxRounds = numArg(raw.maxRounds);
  if (raw.cwd !== undefined) args.cwd = strArg(raw.cwd);
}

// ── 子进程包装（zcode world.run 同构返回）。async spawn + POSIX 进程组（detached）：
// 轮询命令含长 sleep，超时必须整组 kill；与 pr-lifecycle 壳 runCmd 同构（同款超时/
// 进程组/ENOENT 语义，两端 world.run 行为一致）。ENOENT 归一 exit 2 + [cmd-missing]
// stderr 标记。abort 边界：引擎 abort 只杀 worker 线程不通知本脚本，detached 子树
// （长 sleep）会跑完自然退出——sleep 有自身时长上界（pollSeconds+50s 超时），无泄漏面。
const CMD_MISSING = "[cmd-missing]";
function killGroup(child, sig) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // 进程/组已退出
  }
}
function runCmd(cmd, argsArr, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argsArr, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
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
    const timeoutNote = (t) => (t ? "\n[timeout] 子进程超时被终止（整进程组：" + cmd + " " + argsArr.join(" ") + "）" : "");
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
        stderr:
          Buffer.concat(errRef.chunks).toString("utf-8") +
          truncateNote(outRef, "stdout") +
          truncateNote(errRef, "stderr") +
          (extraStderr || ""),
      });
    };
    if (typeof timeoutMs === "number") {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, "SIGTERM");
        killer = setTimeout(() => killGroup(child, "SIGKILL"), 10_000);
        forceSettle = setTimeout(() => {
          killGroup(child, "SIGKILL");
          settle(124, timeoutNote(true) + "\n[force-settle] 进程组回收超时强制返回");
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
      settle(timedOut ? 124 : code === null ? 1 : code, timeoutNote(timedOut));
    });
  });
}

// ── 其余宿主注入物（zcode 通道 → pi 等价物）──
const world = {
  run: (cmd, argsArr, opts) => runCmd(cmd, argsArr, opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined),
};
const report = (obj) => log("[report] " + JSON.stringify(obj));
const artifact = {
  // pi 无进度表卡片通道：表声明与心跳走 log
  table: (_id, spec) => { log("[artifact-table] " + (spec && spec.title ? spec.title : "")); },
  markdown: async (_name, content) => { log(content); },
};

// wait-until.shared.ts — 通用条件等待 workflow 单源公共体
//
// 语义：按参数化的一组确定性检查（CHECK_TYPES 原语词表）轮询外部状态，
// 全部满足即完成并返回结构化报告；达到轮数上限仍不满足则带当前状态停回。
// 零 agent 调用：全部判定走 world.run 确定性命令（bash 包装 git/test/grep/sleep），
// 无模型成本；构建器对「无 agent( 调用点」的断言经 NO_AGENT 显式登记豁免。
//
// 平台形态：zcode = CreateWorkflow path 发起（frontmatter 见 zcode 壳）；
// pi = workflow 工具 action=run + 本产物绝对路径（@pi-meta 见 pi 壳）。
// 两平台 cwd 基准不同（zcode = workspace 根 / pi = 发起进程目录），检查命令
// 统一经 bash 包装（cd "$1" && shift && exec "$@"，全 argv 无注入面），cwd 由
// args.cwd 显式声明；跨 worktree / bare repo 场景必须传 cwd 或 check 级 gitDir。
// ── 参数白名单（fail-fast；`_` 前缀为宿主私有键，跳过）──
const VALID_ARG_KEYS = new Set(["targetLabel", "checks", "pollSeconds", "maxRounds", "cwd"]);
// ── 检查原语词表与必填参数矩阵（新原语在此登记，两字段同加）──
const CHECK_TYPES = new Set(["git-ancestor", "dir-absent", "dir-present", "file-absent", "file-present", "file-contains"]);
const CHECK_REQUIRED = {
    "git-ancestor": ["branch", "target"],
    "dir-absent": ["path"],
    "dir-present": ["path"],
    "file-absent": ["path"],
    "file-present": ["path"],
    "file-contains": ["path", "text"],
};
// ── 参数窄化（单一权威，两平台同一套报错）──
function unknownKey(keys) {
    for (const k of keys) {
        if (!VALID_ARG_KEYS.has(k) && !k.startsWith("_"))
            return k;
    }
    return null;
}
function parseChecks(raw) {
    let arr;
    if (Array.isArray(raw)) {
        arr = raw;
    }
    else if (typeof raw === "string" && raw.trim() !== "") {
        try {
            const parsed = JSON.parse(raw);
            arr = Array.isArray(parsed) ? parsed : [parsed];
        }
        catch {
            return { ok: false, error: "checks 参数为字符串时必须是合法 JSON 数组（pi 平铺承载形态）；解析失败请检查引号转义" };
        }
    }
    else {
        return { ok: false, error: "checks 参数缺失或不是数组——每项形如 {type: \"git-ancestor\", branch: \"feat-x\", target: \"dev-0.12.4\"}；原语词表：" + [...CHECK_TYPES].join("、") };
    }
    if (arr.length === 0) {
        return { ok: false, error: "checks 为空数组——至少声明一个检查条件" };
    }
    const errors = [];
    const checks = [];
    arr.forEach((item, i) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
            errors.push("checks[" + i + "] 必须是对象");
            return;
        }
        const o = item;
        const type = typeof o.type === "string" ? o.type : "";
        if (!CHECK_TYPES.has(type)) {
            errors.push("checks[" + i + "].type「" + (type || "<缺失>") + "」不在原语词表（合法：" + [...CHECK_TYPES].join("、") + "）；新原语的扩展方式见 AGENTS.md 场景路由 wait-until 条目");
            return;
        }
        const spec = { type };
        const getStr = (key) => {
            const v = o[key];
            if (v === undefined || v === null)
                return null;
            if (typeof v !== "string" || v.trim() === "") {
                errors.push("checks[" + i + "]." + key + " 必须是非空字符串");
                return null;
            }
            return v.trim();
        };
        spec.branch = getStr("branch") ?? undefined;
        spec.target = getStr("target") ?? undefined;
        spec.path = getStr("path") ?? undefined;
        spec.text = getStr("text") ?? undefined;
        spec.gitDir = getStr("gitDir") ?? undefined;
        for (const req of CHECK_REQUIRED[type]) {
            if (spec[req] === undefined) {
                errors.push("checks[" + i + "]（" + type + "）缺必填参数 " + req);
            }
        }
        if (spec.gitDir !== undefined && type !== "git-ancestor") {
            errors.push("checks[" + i + "].gitDir 仅 git-ancestor 原语支持（路径类原语不走 git）");
        }
        checks.push(spec);
    });
    if (errors.length > 0) {
        return { ok: false, error: errors.join("；") };
    }
    return { ok: true, checks };
}
function parseNumberArg(v, name, min, fallback) {
    if (v === undefined || v === null || v === "")
        return { ok: true, value: fallback };
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isFinite(n) || n < min) {
        return { ok: false, error: "参数 " + name + " 非法（须为 ≥" + min + " 的数字；实际 " + JSON.stringify(v ?? null) + "）" };
    }
    return { ok: true, value: n };
}
// ── 检查命令执行：统一 bash 包装（cd "$1" && shift && exec "$@"，全 argv 无注入面）──
const CWD = typeof args.cwd === "string" && args.cwd.trim() !== "" ? args.cwd.trim() : ".";
function runIn(argv, timeoutMs) {
    return world.run("bash", ["-c", 'cd "$1" && shift && exec "$@"', "_", CWD, ...argv], timeoutMs !== undefined ? { timeoutMs } : undefined);
}
function clip(text, max) {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) + "…" : t;
}
async function runCheck(spec) {
    const dirArgs = spec.gitDir ? ["--git-dir=" + spec.gitDir] : [];
    if (spec.type === "git-ancestor") {
        const branch = String(spec.branch);
        const target = String(spec.target);
        const cmd = "git merge-base --is-ancestor " + branch + " " + target;
        const r = await runIn(["git", ...dirArgs, "merge-base", "--is-ancestor", branch, target]);
        if (r.exitCode === 0) {
            return { met: true, state: "met", evidence: cmd + " 退出码 0（已并入）" };
        }
        if (r.exitCode === 1) {
            return { met: false, state: "unmet", evidence: cmd + " 退出码 1（尚未并入）" };
        }
        // 非 0/1：分支或目标 ref 可能已随收尾删除，用 rev-parse 区分
        const rev = await runIn(["git", ...dirArgs, "rev-parse", "--verify", "refs/heads/" + branch]);
        if (rev.exitCode !== 0) {
            return { met: true, state: "met-gone", evidence: cmd + " 退出码 " + r.exitCode + " 且分支 " + branch + " 已不存在（rev-parse 退出码 " + rev.exitCode + "）——按随收尾清理满足" };
        }
        return { met: false, state: "invalid", evidence: cmd + " 退出码 " + r.exitCode + " 且分支仍在——异常形态：" + clip(r.stderr, 160) };
    }
    if (spec.type === "dir-absent" || spec.type === "dir-present") {
        const expectAbsent = spec.type === "dir-absent";
        const r = await runIn(["test", "-d", String(spec.path)]);
        const exists = r.exitCode === 0;
        return {
            met: expectAbsent ? !exists : exists,
            state: "met",
            evidence: "test -d " + spec.path + " 退出码 " + r.exitCode + "（" + (exists ? "目录存在" : "目录不存在") + "）",
        };
    }
    if (spec.type === "file-absent" || spec.type === "file-present") {
        const expectAbsent = spec.type === "file-absent";
        const r = await runIn(["test", "-f", String(spec.path)]);
        const exists = r.exitCode === 0;
        return {
            met: expectAbsent ? !exists : exists,
            state: "met",
            evidence: "test -f " + spec.path + " 退出码 " + r.exitCode + "（" + (exists ? "文件存在" : "文件不存在") + "）",
        };
    }
    // file-contains：grep -F 固定串匹配（语义限定单行子串，多行 pattern 不支持）
    const r = await runIn(["grep", "-F", "-q", "--", String(spec.text), String(spec.path)]);
    return {
        met: r.exitCode === 0,
        state: "met",
        evidence: "grep -F -q -- <text> " + spec.path + " 退出码 " + r.exitCode + (r.exitCode === 2 ? "（" + clip(r.stderr, 160) + "）" : ""),
    };
}
function checkLabel(spec) {
    if (spec.type === "git-ancestor")
        return "git-ancestor(" + spec.branch + "→" + spec.target + ")";
    if (spec.type === "file-contains")
        return "file-contains(" + spec.path + ")";
    return spec.type + "(" + spec.path + ")";
}
function stateLabel(state) {
    return state === "met" ? "满足" : state === "met-gone" ? "满足（对象已删除）" : state === "unmet" ? "未满足" : "检查异常";
}
// ── 主流程 ──
const badKey = unknownKey(Object.keys(args));
if (badKey !== null) {
    const report = {
        conclusion: "未知参数「" + badKey + "」——等待未启动。合法参数：" + [...VALID_ARG_KEYS].join("、") + "。修正参数后重新发起。",
        findings: [],
        verified: [],
        notCovered: ["轮询与条件判定全部未执行"],
    };
    return report;
}
const targetLabel = typeof args.targetLabel === "string" && args.targetLabel.trim() !== "" ? args.targetLabel.trim() : "";
if (targetLabel === "") {
    const report = {
        conclusion: "参数 targetLabel 缺失（等待目标的一句中文描述，进结论文案）——等待未启动。补上后重新发起。",
        findings: [],
        verified: [],
        notCovered: ["轮询与条件判定全部未执行"],
    };
    return report;
}
const checksParsed = parseChecks(args.checks);
if (!checksParsed.ok) {
    const report = {
        conclusion: "checks 参数非法——等待未启动。" + checksParsed.error,
        findings: [],
        verified: [],
        notCovered: ["轮询与条件判定全部未执行"],
    };
    return report;
}
const checks = checksParsed.checks;
const pollParsed = parseNumberArg(args.pollSeconds, "pollSeconds", 5, 900);
if (!pollParsed.ok) {
    const report = {
        conclusion: pollParsed.error + "——等待未启动。修正后重新发起。",
        findings: [],
        verified: [],
        notCovered: ["轮询与条件判定全部未执行"],
    };
    return report;
}
const roundsParsed = parseNumberArg(args.maxRounds, "maxRounds", 1, 96);
if (!roundsParsed.ok) {
    const report = {
        conclusion: roundsParsed.error + "——等待未启动。修正后重新发起。",
        findings: [],
        verified: [],
        notCovered: ["轮询与条件判定全部未执行"],
    };
    return report;
}
const POLL_SECONDS = pollParsed.value;
const MAX_ROUNDS = roundsParsed.value;
artifact.table("poll", {
    title: "条件等待进度：" + clip(targetLabel, 60),
    columns: [
        { field: "round", label: "轮次" },
        { field: "metCount", label: "已满足" },
        { field: "total", label: "总数" },
        { field: "detail", label: "各条件状态" },
    ],
    key: "round",
});
function heartbeat(round, outcomes) {
    const detailRaw = checks.map((c, i) => checkLabel(c) + ":" + stateLabel(outcomes[i].state)).join("；");
    return {
        round,
        metCount: outcomes.filter((o) => o.met).length,
        total: checks.length,
        detail: clip(detailRaw, 280),
    };
}
function allMet(outcomes) {
    return outcomes.every((o) => o.met);
}
phase("确认起点状态");
let outcomes = [];
for (const spec of checks) {
    outcomes.push(await runCheck(spec));
}
log("等待「" + targetLabel + "」起点：" + heartbeat(0, outcomes).detail);
report(heartbeat(0, outcomes), "poll");
let done = allMet(outcomes);
phase("按间隔轮询，等待条件全部满足");
let round = 0;
let lastDetail = "";
while (!done && round < MAX_ROUNDS) {
    await runIn(["sleep", String(POLL_SECONDS)], (POLL_SECONDS + 50) * 1000);
    round += 1;
    outcomes = [];
    for (const spec of checks) {
        outcomes.push(await runCheck(spec));
    }
    const beat = heartbeat(round, outcomes);
    report(beat, "poll");
    if (beat.detail !== lastDetail) {
        log("第 " + round + " 轮：" + beat.detail);
        lastDetail = beat.detail;
    }
    done = allMet(outcomes);
}
phase("终态复核并汇总结果");
outcomes = [];
for (const spec of checks) {
    outcomes.push(await runCheck(spec));
}
done = allMet(outcomes);
const finalBeat = heartbeat(round, outcomes);
report(finalBeat, "poll");
const findings = [];
for (let i = 0; i < checks.length; i++) {
    const spec = checks[i];
    const outcome = outcomes[i];
    findings.push({
        where: checkLabel(spec),
        what: "终态：" + stateLabel(outcome.state),
        evidence: outcome.evidence,
        status: outcome.state === "invalid" ? "unconfirmed" : "verified",
        severity: outcome.state === "invalid" ? "medium" : "low",
    });
}
const verified = [
    `每轮按参数化条件逐条执行确定性命令判定（bash 包装 git merge-base --is-ancestor / test -d / test -f / grep -F，全部经 \`cd "$1" && shift && exec "$@"\` 包装，argv 传参无注入面）`,
    "起点快照 + 每轮心跳 report 到 poll 表 + 状态变化时 log；完成判定 = 全部条件 met（含对象已删除的 met-gone 形态）",
];
if (!done) {
    const report = {
        conclusion: "等待「" + targetLabel + "」超时：轮询 " + round + " 轮（上限 " + MAX_ROUNDS + "，每轮 " + POLL_SECONDS + " 秒）后仍有条件未满足——" + finalBeat.detail + "。被等待方可能卡在需要人工裁决的环节（冲突 / 审查 contested / 进程挂起），停回用户处置，不自动进入后续流程。",
        findings,
        verified,
        notCovered: [
            "被等待会话/进程的内部流程质量未验证（本 workflow 只判定参数化条件的落盘事实）",
            "轮询间隔之间的瞬时状态变化不可见",
            "被等待方是否正在等待人工输入未探测",
        ],
    };
    return report;
}
const report = {
    conclusion: "等待「" + targetLabel + "」完成：全部 " + checks.length + " 项条件已满足（第 " + round + " 轮轮询后，每轮间隔 " + POLL_SECONDS + " 秒）——" + finalBeat.detail + "。外部状态已稳定，可进入后续流程。",
    findings,
    verified,
    notCovered: [
        "被等待会话/进程的内部流程质量未验证（本 workflow 只判定参数化条件的落盘事实，不重复其内部门禁/审查）",
    ],
};
return report;

