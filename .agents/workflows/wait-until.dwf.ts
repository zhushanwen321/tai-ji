/* zcode-workflow
description: 通用条件等待 workflow：按参数化的一组确定性检查原语（git-ancestor /
  dir-absent / dir-present / file-absent / file-present / file-contains）轮询外部状态，
  全部满足即返回结构化报告，超时（maxRounds 轮）带终态停回。零 subagent：全部判定走
  bash 包装的确定性命令（git / test / grep / sleep，经 `cd "$1" && shift && exec "$@"`
  argv 传参，无注入面），无模型成本。适用：等待其他会话完成 dev-merge 合并落盘、
  worktree/分支清理、文件出现/消失、台账登记落盘等机器可判定条件。
whenToUse: 需要等待另一个会话/进程/后台任务完成落盘动作后再继续时发起（CreateWorkflow
  path 指向本文件 + args）。被等待方是否在等人工裁决不可探测——超时即停回，不猜。
args:
  targetLabel:
    type: string
    description: 等待目标的一句中文描述（进结论文案与进度表标题；必填）
  checks:
    type: json
    description: 检查条件数组（必填）。每项 = type 原语名 + 必填参数：git-ancestor 需 branch 与 target（可选 gitDir，分支头已并入目标 ref 或分支已随收尾删除均算满足）；dir-absent / dir-present / file-absent / file-present 需 path；file-contains 需 path 与 text（text 为单行固定子串）。gitDir 仅 git-ancestor 支持（bare repo 传相对值或绝对路径）
  pollSeconds:
    type: number
    description: 轮询间隔秒数（≥5；默认 900 = 15 分钟）
    default: 900
  maxRounds:
    type: number
    description: 轮询轮数上限（≥1；默认 96，与默认间隔合 = 24 小时）
    default: 96
  cwd:
    type: string
    description: 检查命令的工作目录（可选；相对路径以平台发起环境当前目录为基准，跨 worktree / bare repo 场景建议传绝对路径。缺省 = 平台默认 cwd——zcode 为 workspace 根，pi 为发起进程目录）
*/

// ── 无观测钩子（O 区不适用）：本 workflow 未接入阶段事件观测（零 agent、纯机器轮询，
//    无技能阶段归属），构建器按「无 initObservation 调用点」跳过观测维度检查。──

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

interface CheckSpec {
  /** 检查原语类型（CHECK_TYPES 词表）。 */
  type: string;
  /** git-ancestor：源分支名。 */
  branch?: string;
  /** git-ancestor：目标 ref（通常是目标 dev 分支）。 */
  target?: string;
  /** 路径类原语的检查路径；file-contains 的被查文件。 */
  path?: string;
  /** file-contains：待查找的单行固定子串。 */
  text?: string;
  /** 可选：git 命令的 --git-dir 值（bare repo / 跨仓场景；省略 = cwd 即 git 仓库）。 */
  gitDir?: string;
}

interface CheckOutcome {
  /** 本轮该条件是否满足。 */
  met: boolean;
  /** 满足形态：met=直接满足；met-gone=对象已随收尾删除，按满足计；unmet=未满足；invalid=检查执行异常。 */
  state: "met" | "met-gone" | "unmet" | "invalid";
  /** 证据：命令与退出码（stderr 摘要）。 */
  evidence: string;
}

interface Finding {
  /** 位置：条件标签（原语 + 参数摘要）。 */
  where: string;
  /** 一句话：该条件的终态。 */
  what: string;
  /** 依据：命令与退出码。 */
  evidence: string;
  /** verified=命令已判定；unconfirmed=检查本身异常、待人工。 */
  status: "verified" | "unconfirmed";
  /** 重要性：high=超时未满足（阻塞后续流程）；low=已满足的条件记录。 */
  severity: "low" | "medium" | "high";
}

interface WaitReport {
  /** 结论：等待是否完成、各条件终态、能否进入后续流程。 */
  conclusion: string;
  findings: Finding[];
  /** 本 run 实际执行的判定方式。 */
  verified: string[];
  /** 没覆盖的部分与原因。 */
  notCovered: string[];
}

interface Heartbeat {
  /** 轮询轮次，从 1 起；round 0 是起点快照。 */
  round: number;
  /** 已满足条件数。 */
  metCount: number;
  /** 条件总数。 */
  total: number;
  /** 各条件状态明细（标签:状态 串接，超 280 字符截断）。 */
  detail: string;
}

// ── 检查原语词表与必填参数矩阵（新原语在此登记，两字段同加）──
const CHECK_TYPES = new Set(["git-ancestor", "dir-absent", "dir-present", "file-absent", "file-present", "file-contains"]);
const CHECK_REQUIRED: Record<string, string[]> = {
  "git-ancestor": ["branch", "target"],
  "dir-absent": ["path"],
  "dir-present": ["path"],
  "file-absent": ["path"],
  "file-present": ["path"],
  "file-contains": ["path", "text"],
};

// ── 参数窄化（单一权威，两平台同一套报错）──
function unknownKey(keys: string[]): string | null {
  for (const k of keys) {
    if (!VALID_ARG_KEYS.has(k) && !k.startsWith("_")) return k;
  }
  return null;
}

function parseChecks(raw: unknown): { ok: true; checks: CheckSpec[] } | { ok: false; error: string } {
  let arr: unknown[];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return { ok: false, error: "checks 参数为字符串时必须是合法 JSON 数组（pi 平铺承载形态）；解析失败请检查引号转义" };
    }
  } else {
    return { ok: false, error: "checks 参数缺失或不是数组——每项形如 {type: \"git-ancestor\", branch: \"feat-x\", target: \"dev-0.12.4\"}；原语词表：" + [...CHECK_TYPES].join("、") };
  }
  if (arr.length === 0) {
    return { ok: false, error: "checks 为空数组——至少声明一个检查条件" };
  }
  const errors: string[] = [];
  const checks: CheckSpec[] = [];
  arr.forEach((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push("checks[" + i + "] 必须是对象");
      return;
    }
    const o = item as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";
    if (!CHECK_TYPES.has(type)) {
      errors.push("checks[" + i + "].type「" + (type || "<缺失>") + "」不在原语词表（合法：" + [...CHECK_TYPES].join("、") + "）；新原语的扩展方式见 AGENTS.md 场景路由 wait-until 条目");
      return;
    }
    const spec: CheckSpec = { type };
    const getStr = (key: string): string | null => {
      const v = o[key];
      if (v === undefined || v === null) return null;
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
      if (spec[req as "branch" | "target" | "path" | "text"] === undefined) {
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

function parseNumberArg(v: unknown, name: string, min: number, fallback: number): { ok: true; value: number } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "") return { ok: true, value: fallback };
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n < min) {
    return { ok: false, error: "参数 " + name + " 非法（须为 ≥" + min + " 的数字；实际 " + JSON.stringify(v ?? null) + "）" };
  }
  return { ok: true, value: n };
}

// ── 检查命令执行：统一 bash 包装（cd "$1" && shift && exec "$@"，全 argv 无注入面）──
const CWD = typeof args.cwd === "string" && args.cwd.trim() !== "" ? args.cwd.trim() : ".";

function runIn(argv: string[], timeoutMs?: number) {
  return world.run("bash", ["-c", 'cd "$1" && shift && exec "$@"', "_", CWD, ...argv], timeoutMs !== undefined ? { timeoutMs } : undefined);
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

async function runCheck(spec: CheckSpec): Promise<CheckOutcome> {
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
    const met = expectAbsent ? !exists : exists;
    return {
      met,
      state: met ? "met" : "unmet",
      evidence: "test -d " + spec.path + " 退出码 " + r.exitCode + "（" + (exists ? "目录存在" : "目录不存在") + "）",
    };
  }
  if (spec.type === "file-absent" || spec.type === "file-present") {
    const expectAbsent = spec.type === "file-absent";
    const r = await runIn(["test", "-f", String(spec.path)]);
    const exists = r.exitCode === 0;
    const met = expectAbsent ? !exists : exists;
    return {
      met,
      state: met ? "met" : "unmet",
      evidence: "test -f " + spec.path + " 退出码 " + r.exitCode + "（" + (exists ? "文件存在" : "文件不存在") + "）",
    };
  }
  // file-contains：grep -F 固定串匹配（语义限定单行子串，多行 pattern 不支持）
  const r = await runIn(["grep", "-F", "-q", "--", String(spec.text), String(spec.path)]);
  const containsMet = r.exitCode === 0;
  return {
    met: containsMet,
    state: containsMet ? "met" : "unmet",
    evidence: "grep -F -q -- <text> " + spec.path + " 退出码 " + r.exitCode + (r.exitCode === 2 ? "（" + clip(r.stderr, 160) + "）" : ""),
  };
}

function checkLabel(spec: CheckSpec): string {
  if (spec.type === "git-ancestor") return "git-ancestor(" + spec.branch + "→" + spec.target + ")";
  if (spec.type === "file-contains") return "file-contains(" + spec.path + ")";
  return spec.type + "(" + spec.path + ")";
}

function stateLabel(state: CheckOutcome["state"]): string {
  return state === "met" ? "满足" : state === "met-gone" ? "满足（对象已删除）" : state === "unmet" ? "未满足" : "检查异常";
}

// ── 主流程 ──
const badKey = unknownKey(Object.keys(args));
if (badKey !== null) {
  const waitReport: WaitReport = {
    conclusion: "未知参数「" + badKey + "」——等待未启动。合法参数：" + [...VALID_ARG_KEYS].join("、") + "。修正参数后重新发起。",
    findings: [],
    verified: [],
    notCovered: ["轮询与条件判定全部未执行"],
  };
  return waitReport;
}

const targetLabel = typeof args.targetLabel === "string" && args.targetLabel.trim() !== "" ? args.targetLabel.trim() : "";
if (targetLabel === "") {
  const waitReport: WaitReport = {
    conclusion: "参数 targetLabel 缺失（等待目标的一句中文描述，进结论文案）——等待未启动。补上后重新发起。",
    findings: [],
    verified: [],
    notCovered: ["轮询与条件判定全部未执行"],
  };
  return waitReport;
}

const checksParsed = parseChecks(args.checks);
if (!checksParsed.ok) {
  const waitReport: WaitReport = {
    conclusion: "checks 参数非法——等待未启动。" + checksParsed.error,
    findings: [],
    verified: [],
    notCovered: ["轮询与条件判定全部未执行"],
  };
  return waitReport;
}
const checks = checksParsed.checks;

const pollParsed = parseNumberArg(args.pollSeconds, "pollSeconds", 5, 900);
if (!pollParsed.ok) {
  const waitReport: WaitReport = {
    conclusion: pollParsed.error + "——等待未启动。修正后重新发起。",
    findings: [],
    verified: [],
    notCovered: ["轮询与条件判定全部未执行"],
  };
  return waitReport;
}
const roundsParsed = parseNumberArg(args.maxRounds, "maxRounds", 1, 96);
if (!roundsParsed.ok) {
  const waitReport: WaitReport = {
    conclusion: roundsParsed.error + "——等待未启动。修正后重新发起。",
    findings: [],
    verified: [],
    notCovered: ["轮询与条件判定全部未执行"],
  };
  return waitReport;
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

function heartbeat(round: number, outcomes: CheckOutcome[]): Heartbeat {
  const detailRaw = checks.map((c, i) => checkLabel(c) + ":" + stateLabel(outcomes[i].state)).join("；");
  return {
    round,
    metCount: outcomes.filter((o) => o.met).length,
    total: checks.length,
    detail: clip(detailRaw, 280),
  };
}

function allMet(outcomes: CheckOutcome[]): boolean {
  return outcomes.every((o) => o.met);
}

phase("确认起点状态");
let outcomes: CheckOutcome[] = [];
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

const findings: Finding[] = [];
for (let i = 0; i < checks.length; i++) {
  const spec = checks[i];
  const outcome = outcomes[i];
  findings.push({
    where: checkLabel(spec),
    what: "终态：" + stateLabel(outcome.state),
    evidence: outcome.evidence,
    status: outcome.state === "invalid" ? "unconfirmed" : "verified",
    // 超时停回场景下未满足的条件 = 阻塞后续流程，标 high；其余为记录性条目
    severity: outcome.state === "invalid" ? "medium" : !done && !outcome.met ? "high" : "low",
  });
}

const verified = [
  `每轮按参数化条件逐条执行确定性命令判定（bash 包装 git merge-base --is-ancestor / test -d / test -f / grep -F，全部经 \`cd "$1" && shift && exec "$@"\` 包装，argv 传参无注入面）`,
  "起点快照 + 每轮心跳 report 到 poll 表 + 状态变化时 log；完成判定 = 全部条件 met（含对象已删除的 met-gone 形态）",
];

if (!done) {
  const waitReport: WaitReport = {
    conclusion: "等待「" + targetLabel + "」超时：轮询 " + round + " 轮（上限 " + MAX_ROUNDS + "，每轮 " + POLL_SECONDS + " 秒）后仍有条件未满足——" + finalBeat.detail + "。被等待方可能卡在需要人工裁决的环节（冲突 / 审查 contested / 进程挂起），停回用户处置，不自动进入后续流程。",
    findings,
    verified,
    notCovered: [
      "被等待会话/进程的内部流程质量未验证（本 workflow 只判定参数化条件的落盘事实）",
      "轮询间隔之间的瞬时状态变化不可见",
      "被等待方是否正在等待人工输入未探测",
    ],
  };
  return waitReport;
}

const waitReport: WaitReport = {
  conclusion: "等待「" + targetLabel + "」完成：全部 " + checks.length + " 项条件已满足（第 " + round + " 轮轮询后，每轮间隔 " + POLL_SECONDS + " 秒）——" + finalBeat.detail + "。外部状态已稳定，可进入后续流程。",
  findings,
  verified,
  notCovered: [
    "被等待会话/进程的内部流程质量未验证（本 workflow 只判定参数化条件的落盘事实，不重复其内部门禁/审查）",
  ],
};
return waitReport;
