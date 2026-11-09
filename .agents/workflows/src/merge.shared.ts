// merge.shared.ts — merge skill 九阶段合并发布流程的单 workflow 公共体（zcode+pi 双平台单源）
// 本文件由 .agents/workflows/scripts/build-workflows.mjs 拼进两壳生成产物：
//   zcode = .agents/workflows/merge.dwf.ts；pi = .agents/workflows/merge.js（勿手工维护产物）。
//
// 流程（15 step，强串行；编号对应 merge SKILL.md 的阶段）：
//   preflight → init（阶段 0）→ squash-check（0.5，agent 判定）→ premerge（1）→
//   prune-devlink（1.5）→ pr-merge（2）→ post-merge-ci（3）→ version-check（3.5）→
//   e2e-select（3.7，只圈清单不跑真机）→ bump-release（4）→ npm-detect（4N 检测移交）→
//   notes（5，agent 撰写双语）→ verify（6）→ gitcode-sync（6.5）→ cleanup（7）
//
// 异常三层架构：
//   第 1 层 = 脚本内既有韧性（pr-merge 合并竞态复查 / gitcode 断点续传 / wait-for-ci 抖动
//     判定 / 各脚本幂等性），本流程直接复用不重造；
//   第 2 层 = FAILURE_ROUTES 机器分类路由：按脚本固定错误文本（脚本自定义的输出协议，
//     与 exit code 同族的机器契约）把失败路由到 retry（幂等网络类）/ retry-extended
//     （CI 等待超时加时或重跑）/ rescue（白名单阶段派兜底 agent）/ escalate（停回）；
//   第 3 层 = rescue 兜底 agent：仅 premerge / version-check / bump-release 三个白名单
//     场景，修复后由本流程重跑原脚本判定（不信 agent 自报成功），轮次上限默认 2。
//
// 安全与恢复：
// - 失败终态一律 return 不 throw（throw 的 errored run 不可 resume 且丢结构化 error）。
// - 阶段 4 幂等预检：远端 tag 已存在 = bump+push 已完成 → 直接进 verify（非幂等段可重跑）；
//   基线查询失败（ls-remote/gh）停回，不在基线未知时盲目续跑。
// - 阶段 3 no-runs 放行补验：wait-for-ci 以「未检测到 CI workflow」放行时 gh run list
//   独立复核——真无 run 披露放行；查到 run（放行判定与事实不符）停回。
// - 状态机闭环：verify 通过后落 .merge-state 终态 released（对齐人工路径 release 阶段，
//   终态不再参与 12h 发布互斥；写失败仅告警）。
// - 阶段 7 零未决失败机器门禁：skipSteps 接管过非 squash-check 的 step = 该环节未在流程
//   内验证 → needs-human 保留现场，绝不带病清理（SKILL 阶段 7 门禁 [MANDATORY]）。
// - 全程 world.run + worktree 包装（bash -c 'cd <wt> && exec "$@"'），免会话 bash 依赖；
//   cleanup 删除 feature worktree 后流程不受影响（所有命令 cd main 执行）。
// - 恢复双通道：run 被中断 → ResumeWorkflowRun（journal 重放，已成功步骤零重跑）；
//   failed 终态处置后 → 重新发起 + args.skipSteps 跳过已完成 step。
//
// 已裁决范围（2026-11-09）：0.5 = agent 判定无需整理放行、需整理停回（needs-squash-
// approval）；4N = 检测到 extensions 改动时记录 npmHandoff 移交主 agent 人工段，主链继续；
// 3.7 真机 e2e 默认不跑（A2 烧真实 token 须用户当场确认，SKILL 现行语义）。

// ── 显式 worktree 根包装（同 pr-lifecycle 形态）──
// zcode 宿主命令执行 cwd 绑会话工作目录（workspace 根是 bare 容器，非 git 仓库）——
// 全部命令经 bash -c 'cd <wt> && exec "$@"' 包装；wt 在 execCmd 每次调用前按 cwd 实参
// 显式赋值（main / feature 两目录切换，无跨调用残留依赖）。业务参数走位置参数（"$@"），
// 零 shell 转义面。world.run 首参恒为编译期字面量（zcode 编译器要求）。
let wt = "";
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
const runSh = (cmd: string, a: readonly string[] = [], opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const bashArgs = ["-c", wt === "" ? `exec "$@"` : `cd ${shq(wt)} && exec "$@"`, "bash", cmd, ...a];
  // opts 省略时不得显式传 undefined 第三参（引擎规范化为 null 后拒绝）
  const r = opts === undefined ? world.run("bash", bashArgs) : world.run("bash", bashArgs, opts);
  // world.run 仅在「spawn 失败 / 超时」时 reject（平台契约）——归一为 exit 码形态，
  // 与 pi 壳 runCmd 的「超时 124 / 命令缺失非 0」同构，FAILURE_ROUTES 分类与
  // rerunHint 对两平台一致可用（reject 直接穿透会丢失路由分类）
  return r.catch((e: unknown) => {
    const msg = String(e instanceof Error ? e.message : e);
    const timedOut = /timed?[- ]?out|timeout|超时/i.test(msg);
    return { exitCode: timedOut ? 124 : 127, stdout: "", stderr: `[${timedOut ? "timeout" : "spawn-failed"}] ${msg}` };
  });
};

function tailLines(text: string, n: number): string {
  const lines = String(text || "").trimEnd().split("\n");
  return lines.length <= n ? String(text || "").trimEnd() : lines.slice(-n).join("\n");
}

// nodeAbs 在下方环境预检解析（step 体系外——skipSteps 跳过 preflight 时依然可用）；
// runNode 闭包引用，调用时恒已赋值。node/pnpm/git 写操作统一经绝对路径或 PATH 前缀，
// 结构性不依赖引擎默认 PATH（pre-commit 钩子子进程需要可用的 node/npx/pnpm）。
let nodeAbs = "";
// cwd 显式给定时不吃全局 wt 残留值（skipSteps 大面积跳步时 wt 可能停留在 feature
// 目录——相对路径脚本调用必须固定在预期 worktree）
const runNode = (nodeArgs: string[], opts?: { timeoutMs?: number; cwd?: "main" | "feature" }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  if (opts?.cwd !== undefined) wt = opts.cwd === "main" ? mainWt : featWt;
  return runSh("sh", ["-c", [shq(nodeAbs), ...nodeArgs.map(shq)].join(" ")], opts);
};
const nodeBinDir = (): string => nodeAbs.slice(0, nodeAbs.lastIndexOf("/"));
const PATH_PREFIX = (): string => `PATH=${shq(nodeBinDir())}:"$HOME"/Library/pnpm:"$PATH" `;

// 文件读探针（大输出一律落日志文件 + 尾部回读——world.run stdout 256KB 捕获上限，
// 超限 reject；pr-lifecycle 实测 284940 bytes 炸过）
const READ_TAIL =
  "try{const t=require('fs').readFileSync(process.argv[1],'utf-8').trimEnd();" +
  "const n=Number(process.argv[2]||'80');const ls=t.split('\\n');" +
  "process.stdout.write(ls.length<=n?t:ls.slice(-n).join('\\n'))}catch(e){process.stdout.write('')}";
const READ_FILE_QUIET =
  "try{process.stdout.write(require('fs').readFileSync(process.argv[1],'utf-8'))}catch(e){process.stdout.write('')}";

async function readTailViaNode(path: string, n: number): Promise<string> {
  const r = await runNode(["-e", READ_TAIL, path, String(n)]);
  return r.exitCode === 0 ? r.stdout.trimEnd() : "";
}
async function readFileViaNode(path: string): Promise<string> {
  const r = await runNode(["-e", READ_FILE_QUIET, path]);
  return r.exitCode === 0 ? r.stdout : "";
}

// 观测层源 hash 探针（B-1 跨仓产物过期防线，同 pr-lifecycle）：现算安装位观测层源文件
// sha256 与构建器注入的 OBS_LAYER_SHA256 常量比对，不一致即终止（重建后重新发起）。
const NODE_OBS_HASH =
  "const fs=require('fs'),c=require('crypto'),p=require('path');" +
  "const f=p.join(require('os').homedir(),'.agents','scripts','workflow-observability.shared.ts');" +
  "try{process.stdout.write(c.createHash('sha256').update(fs.readFileSync(f)).digest('hex'))}" +
  "catch{process.stdout.write('missing')}";

// ── 观测启动（先于全部参数校验——参数校验失败早退的执行也有 execution 边界）──
phase("环境预检");
obsCtx = initObservation("merge", "release", null); // skill=所属 skill 名；stage=发布流水线
{
  const obsHomeRes = await runSh("node", ["-e", "process.stdout.write(require('os').homedir())"]);
  if (obsHomeRes.exitCode === 0 && obsHomeRes.stdout.trim() !== "") obsAttachHome(obsHomeRes.stdout.trim());
}
await obsEmit("execution", null, "start", null);
// 参数/装配早退的观测收尾：initObservation 之后、终态统一补记之前的 throw 一律先经本
// helper 补 execution end（带 outcome）再抛
async function failObs(kind: string, msg: string): Promise<never> {
  await obsCloseExecution(kind);
  throw new Error(msg);
}
{
  const r = await world.run("node", ["-e", NODE_OBS_HASH]);
  const actual = r.exitCode === 0 ? r.stdout.trim() : "";
  if (actual === "") {
    await failObs("setup-failure", `观测层源 hash 探针未产出判定（node exit ${r.exitCode}）——引擎 PATH 无 node 时本探针必然如此。恢复：确认宿主 node 可用后重新发起`);
  }
  if (actual === "missing") {
    await failObs("setup-failure", "观测层源文件缺失（安装位 ~/.agents/scripts/workflow-observability.shared.ts）。恢复：确认观测层已安装后重新发起");
  }
  if (actual !== OBS_LAYER_SHA256) {
    await failObs("setup-failure", `观测层源现算 sha256=${actual.slice(0, 12)}… ≠ 产物内嵌 ${OBS_LAYER_SHA256.slice(0, 12)}…——观测层源已更新而本 workflow 产物未重建。恢复：node .agents/workflows/scripts/build-workflows.mjs 后重新发起`);
  }
}

// ── 参数窄化 + 白名单（拼错键静默回落默认值比报错危险，fail-fast）──
const STEP_IDS = [
  "preflight", "init", "squash-check", "premerge", "prune-devlink", "pr-merge",
  "post-merge-ci", "version-check", "e2e-select", "bump-release", "npm-detect",
  "notes", "verify", "gitcode-sync", "cleanup",
] as const;
const VALID_ARG_KEYS = new Set(["worktree", "prNumber", "squashMode", "maxRescueRounds", "skipSteps", "taskId", "executionId", "sampleType"]);
for (const key of Object.keys(args)) {
  if (!VALID_ARG_KEYS.has(key)) {
    await failObs("invalid-args", `未知参数: ${key}（合法参数: ${[...VALID_ARG_KEYS].join("/")}）`);
  }
}
const rawWorktree = typeof args.worktree === "string" ? args.worktree.trim() : "";
if (rawWorktree === "" || !rawWorktree.startsWith("/")) {
  await failObs("invalid-args", `参数 worktree 必传且为 feature worktree 绝对路径（当前值：${JSON.stringify(args.worktree ?? "")}）——merge 全流程在 main 与该 worktree 两目录操作，cwd 包装依赖绝对路径`);
}
{
  const probeScript = `if [ -d ${shq(rawWorktree)} ]; then echo dir; elif [ -e ${shq(rawWorktree)} ]; then echo file; else echo missing; fi`;
  const p = await world.run("bash", ["-c", probeScript]);
  const shape = p.exitCode === 0 ? p.stdout.trim() : "";
  if (shape !== "dir") {
    await failObs("invalid-args", `worktree 参数指向的路径不是有效目录：${rawWorktree}（探针=${shape || "未知"}；常见成因：路径写错 / 该 worktree 已被 cleanup）。恢复：ls <workspace 根> 核对后重新发起`);
  }
}
// workspace 布局推导（bare 容器：全部 worktree 均为 workspace 根的直接子目录；.agents
// 实体在 workspace 根，各 worktree 内经 symlink 共享——脚本一律经 main worktree 的
// .agents symlink 路径调用，与 SKILL「实体恒存在」约定一致）
const featWt = rawWorktree.replace(/\/+$/, "");
const wsRoot = featWt.slice(0, featWt.lastIndexOf("/"));
const branchName = featWt.slice(featWt.lastIndexOf("/") + 1);
const mainWt = `${wsRoot}/main`;
if (branchName === "main") {
  await failObs("invalid-args", "worktree 参数不得指向 main worktree——阶段 7 会删除传入的 worktree，传 main 会删主工作区（SKILL 阶段 0 关键警告）");
}
const squashModeRaw = typeof args.squashMode === "string" ? args.squashMode.trim() : "";
const squashMode = squashModeRaw === "" ? "auto" : squashModeRaw;
if (squashMode !== "auto" && squashMode !== "skip") {
  await failObs("invalid-args", `参数 squashMode 非法：${squashModeRaw}（合法值 auto=agent 判定 / skip=跳过 commit 整理）`);
}
const maxRescueRoundsRaw = args.maxRescueRounds;
const maxRescueRounds = maxRescueRoundsRaw === undefined ? 2 : Number(maxRescueRoundsRaw);
if (!Number.isInteger(maxRescueRounds) || maxRescueRounds < 0 || maxRescueRounds > 5) {
  await failObs("invalid-args", `参数 maxRescueRounds 非法：${JSON.stringify(maxRescueRoundsRaw)}（合法值 0-5 整数，默认 2；0 = 不派 rescue agent）`);
}
const skipStepsRaw = Array.isArray(args.skipSteps) ? args.skipSteps : [];
const skipSet = new Set<string>();
for (const s of skipStepsRaw) {
  if (typeof s !== "string" || !(STEP_IDS as readonly string[]).includes(s)) {
    await failObs("invalid-args", `skipSteps 含非法 step id：${JSON.stringify(s)}（合法值 ${STEP_IDS.join("/")}）`);
  }
  skipSet.add(s);
}
let prNumber = typeof args.prNumber === "number" && Number.isInteger(args.prNumber) && args.prNumber > 0 ? args.prNumber : 0;
if (args.prNumber !== undefined && prNumber === 0) {
  await failObs("invalid-args", `参数 prNumber 非法：${JSON.stringify(args.prNumber)}（应为正整数 PR 号；缺省由 init.sh 输出取）`);
}
if (skipSet.has("init") && prNumber === 0) {
  await failObs("invalid-args", "skipSteps 含 init 时必须显式传 prNumber——init.sh 是 PR 号的发现入口，跳过后后续 step 无从取得");
}
const skippedSteps: { step: string; reason: string }[] = [];

// ── 环境预检（step 体系外）：node 绝对路径解析 + main worktree 核对 + 日志目录 ──
{
  const probes = [
    "command -v node 2>/dev/null",
    'ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1',
    "ls -1 /usr/local/bin/node /opt/homebrew/bin/node 2>/dev/null | head -1",
  ];
  for (const script of probes) {
    const r = await runSh("sh", ["-c", script]);
    const p = (r.exitCode === 0 ? r.stdout : "").trim().split("\n").filter(Boolean).pop() ?? "";
    if (p.startsWith("/")) {
      nodeAbs = p;
      break;
    }
  }
}
if (nodeAbs === "") {
  await failObs("setup-failure", "无法定位 node 可执行文件（command -v / nvm 目录 / 常见安装位均未命中）——本流程的 node 调用经绝对路径执行、git/pnpm 经 PATH 前缀执行。恢复：把 nvm node 暴露到系统级 PATH 后重新发起");
}
const runLogDir = `${wsRoot}/.tmp/merge-workflow`;
{
  const mk = await runNode(["-e", "require('fs').mkdirSync(process.argv[1],{recursive:true})", runLogDir]);
  if (mk.exitCode !== 0) {
    await failObs("setup-failure", `日志目录创建失败（${runLogDir}）：${mk.stderr.trim()}。恢复：核对 .tmp 目录可写后重新发起`);
  }
}
log(`环境：node=${nodeAbs}；workspace=${wsRoot}；feature=${branchName}`);

// ── 全局状态 ──
interface Failure {
  step: string;
  error: string;
  /** 缺省 = failed；needs-squash-approval = 整理计划待批准；needs-human = 清理门禁拦截 */
  status?: "needs-squash-approval" | "needs-human";
}
let failure: Failure | null = null;
const stages: Record<string, string> = {};
interface RescueLogEntry {
  step: string;
  round: number;
  action: string;
  summary: string;
  filesChanged: string[];
  residualRisk: string;
}
const rescueLog: RescueLogEntry[] = [];
let mergeSha = "";
let releaseTag = "";
let releaseUrl = "";
let squashNote = "（未执行）";
let e2eNote = "（未执行）";
// SKILL 6.5.2「人工过目 git diff」在 workflow 形态的等价物：diff 摘要入终态报告披露
// （空串 = 未产生：README 已是目标版本或未执行到 6.5.2）
let readmeDiffNote = "";
interface NpmHandoff {
  detected: boolean;
  detail: string;
}
let npmHandoff: NpmHandoff = { detected: false, detail: "（未执行）" };
const prUrl = (): string => (prNumber > 0 ? `https://github.com/zhushanwen321/tai-ji/pull/${prNumber}` : "");

// ── 统一执行层 ──
interface ExecResult {
  exitCode: number;
  /** 路由与诊断输入：直接 stdout+stderr，或日志文件尾部（logName 形态） */
  text: string;
}
interface CmdSpec {
  cwd: "main" | "feature";
  /** argv 形态：脚本/外部命令直跑（bash/zsh/curl/python3 等，PATH 按现状） */
  argv?: string[];
  /** rawScript 形态：pnpm/git 写操作等需要 PATH 前缀的命令（自动加 PATH_PREFIX） */
  rawScript?: string;
  /** 填了则 stdout+stderr 重定向到 ${runLogDir}/<logName>.log，text 取日志尾部 */
  logName?: string;
  timeoutMs: number;
}
async function execCmd(spec: CmdSpec): Promise<ExecResult> {
  wt = spec.cwd === "main" ? mainWt : featWt;
  const logFile = spec.logName !== undefined ? `${runLogDir}/${spec.logName}.log` : "";
  const base = spec.rawScript !== undefined ? PATH_PREFIX() + spec.rawScript : (spec.argv ?? []).map(shq).join(" ");
  const body = base + (logFile !== "" ? ` > ${shq(logFile)} 2>&1` : "");
  const r = await runSh("sh", ["-c", body], { timeoutMs: spec.timeoutMs });
  const text = logFile !== "" ? await readTailViaNode(logFile, 80) : `${r.stdout}\n${r.stderr}`.trim();
  return { exitCode: r.exitCode, text };
}

// 失败分类路由表（第 2 层）：match = 脚本固定错误文本（脚本自定义的输出协议，与 exit
// code 同族的机器契约——protocol-parse 类合法判定原语，非证据扫描）。按声明顺序首个
// 命中生效；未命中走 defaultAction。
type RouteAction = "retry" | "retry-extended" | "rescue" | "escalate";
interface FailureRoute {
  match: string;
  action: RouteAction;
  hint?: string;
}
const FAILURE_ROUTES: Record<string, { routes: FailureRoute[]; defaultAction: RouteAction }> = {
  init: {
    routes: [
      { match: "检测到疑似进行中的发布管线", action: "escalate", hint: "进行中的发布管线占用 .merge-state/current.json——不得自动删状态文件。三查确认上一轮已收官（gh release view 最近两版 + git ls-remote 双 tag 均在远端）后，人工删除该文件再重跑" },
    ],
    defaultAction: "escalate",
  },
  premerge: { routes: [], defaultAction: "rescue" },
  "pr-merge": {
    routes: [
      { match: "CI 状态查询持续失败", action: "retry" },
      { match: "30 分钟内未完成", action: "retry" },
      { match: "PR CI 有失败项", action: "escalate", hint: "PR CI 红——回开发线修复后重走发布，不得在发布线修代码" },
      { match: "30 秒内未检测到", action: "escalate", hint: "未检测到 CI run——确认是否纯 docs 改动（ci.yml 路径过滤），人工确认后方可合并" },
      { match: "疑似进行中的发布管线", action: "escalate", hint: "发布管线互斥——按 init 的三查指引处置" },
      { match: "本地 main 领先", action: "escalate", hint: "本地 main 领先远端（疑似发布在途：阶段 4 bump / 阶段 5 notes 已 commit 未 push）——人工核查未推送 commit，不得自动 reset" },
      { match: "有未提交的 tracked 改动", action: "escalate", hint: "main 工作区有未提交变更（疑似阶段 4 中途崩溃半成品或人工改动）——人工处置后重跑，不得自动清理" },
      { match: "PR 状态为", action: "escalate" },
    ],
    defaultAction: "escalate",
  },
  "post-merge-ci": {
    routes: [
      { match: "等待超时", action: "retry-extended" },
      { match: "查询持续失败", action: "retry" },
    ],
    defaultAction: "escalate",
  },
  "version-check": {
    routes: [
      { match: "pi 协议契约测试失败", action: "escalate", hint: "上游 pi 协议漂移（W25 接线）——先处理协议漂移再 bump，不得动版本号" },
      { match: "版本不匹配", action: "rescue" },
    ],
    defaultAction: "escalate",
  },
  "bump-commit": { routes: [], defaultAction: "rescue" },
  push: {
    routes: [
      { match: "Could not resolve", action: "retry" },
      { match: "Failed to connect", action: "retry" },
      { match: "timed out", action: "retry" },
      { match: "Connection reset", action: "retry" },
      { match: "non-fast-forward", action: "escalate", hint: "远端已前进——禁止强推 main/tag，人工核查远端变更" },
      { match: "rejected", action: "escalate" },
    ],
    defaultAction: "escalate",
  },
  "verify-release": {
    routes: [
      { match: "CI 状态查询持续失败", action: "retry" },
      { match: "CI 超时", action: "retry-extended" },
      { match: "CI 构建失败", action: "escalate", hint: "release CI 红——gh run view --log-failed 归因；禁止删除重传同版本号 asset（同版本 re-upload 禁令）" },
      { match: "未创建", action: "escalate" },
      { match: "仍为 draft", action: "escalate" },
      { match: "没有任何产物", action: "escalate" },
      { match: "产物校验失败", action: "escalate" },
    ],
    defaultAction: "escalate",
  },
  "gitcode-sync": { routes: [], defaultAction: "retry" },
};

interface RoutedSpec extends CmdSpec {
  routeKey: string;
  /** rescue 白名单场景（route 命中 rescue 动作时派兜底 agent；未填则 rescue 按 escalate） */
  rescueStage?: "premerge" | "version-check" | "bump-release";
  /** retry-extended 的替换形态（如 wait-for-ci 加时 --timeout 3600） */
  extended?: { argv?: string[]; rawScript?: string; timeoutMs: number };
  /** retry 动作的次数上限（默认 2；retry-extended 恒 1 次） */
  maxRetries?: number;
  /** 停回时的恢复指引（重跑命令全文，cd 自包含） */
  rerunHint: string;
  /** exit 0 后的附加核验（如 no-runs 放行补验）；throw 即停回 */
  passCheck?: (r: ExecResult) => Promise<void>;
}

class Escalation extends Error {}

async function runRouted(spec: RoutedSpec): Promise<ExecResult> {
  const table = FAILURE_ROUTES[spec.routeKey];
  const maxRetries = spec.maxRetries ?? 2;
  let retries = 0;
  let extendedUsed = false;
  let rescueRound = 0;
  let current: CmdSpec = spec;
  const rescueNotes: string[] = [];
  for (;;) {
    const r = await execCmd(current);
    if (r.exitCode === 0) {
      if (spec.passCheck !== undefined) await spec.passCheck(r);
      return r;
    }
    const route = table.routes.find((x) => r.text.includes(x.match)) ?? null;
    const action = route?.action ?? table.defaultAction;
    const hint = route?.hint ?? "";
    if (action === "retry" && retries < maxRetries) {
      retries++;
      log(`[${spec.routeKey}] 失败路由=retry（第 ${retries}/${maxRetries} 次重跑，幂等）：${hint || "网络/工具错误类"}`);
      continue;
    }
    if (action === "retry-extended" && !extendedUsed && spec.extended !== undefined) {
      extendedUsed = true;
      current = { ...current, argv: spec.extended.argv ?? current.argv, rawScript: spec.extended.rawScript ?? current.rawScript, timeoutMs: spec.extended.timeoutMs };
      log(`[${spec.routeKey}] 失败路由=retry-extended（加时/重跑一次）：${hint}`);
      continue;
    }
    if (action === "rescue" && spec.rescueStage !== undefined && rescueRound < maxRescueRounds) {
      rescueRound++;
      log(`[${spec.routeKey}] 失败路由=rescue（第 ${rescueRound}/${maxRescueRounds} 轮兜底修复）`);
      // 直发事件（不占打开槽——withStage(step) 的 openStep 不被嵌套打断）；
      // finally 补 end——rescueOnce 两次无效返回抛出时 JSONL 事件仍配对完整
      await obsEmit("fix", rescueRound, "start", null);
      let report: RescueReport;
      try {
        report = await rescueOnce(spec.rescueStage, rescueRound, r.text, spec.rerunHint);
      } finally {
        await obsEmit("fix", rescueRound, "end", null);
      }
      rescueLog.push({ step: spec.routeKey, round: rescueRound, action: report.action, summary: report.summary, filesChanged: report.filesChanged, residualRisk: report.residualRisk });
      rescueNotes.push(`r${rescueRound}: ${report.summary}`);
      if (report.action === "escalate") {
        throw new Escalation(`[${spec.routeKey}] rescue agent 判定不可自动修复：${report.summary}\n失败输出尾部：\n${tailLines(r.text, 40)}\n恢复：${spec.rerunHint}`);
      }
      continue; // 修复后由本流程重跑原脚本判定（不信 agent 自报成功）
    }
    const rescueNote = rescueNotes.length > 0 ? `\nrescue 历轮：${rescueNotes.join("；")}` : "";
    throw new Escalation(
      `[${spec.routeKey}] 失败（路由=${action}${route === null ? "，未命中分类表按默认" : ""}）${hint !== "" ? `：${hint}` : ""}\n退出码=${r.exitCode}${rescueNote}\n失败输出尾部：\n${tailLines(r.text, 50)}\n恢复：${spec.rerunHint}`,
    );
  }
}

// ── rescue 兜底 agent（第 3 层）：白名单三场景，结构化返回 + 校验失败重试一次 ──
interface RescueReport {
  action: "fixed" | "retry" | "escalate";
  summary: string;
  filesChanged: string[];
  residualRisk: string;
}
const RESCUE_REDLINES = [
  "红线（违反任何一条 = 修复失败，直接返回 escalate）：",
  "- 禁止 --no-verify / SKIP_* 环境变量 / eslint-disable / 改 lint 规则 / 改测试断言换绿 / 改 CI 配置",
  "- 禁止 git reset --hard / git clean / 改写 main 历史 / 删除 .merge-state/current.json / 重打或删除远端 tag",
  "- 禁止操作另一 worktree（premerge 限 feature worktree；version-check 与 bump-release 限 main worktree 且不得 push）",
  "- 拿不准的一律返回 escalate，不得勉强修复",
].join("\n");

function rescuePrompt(stage: "premerge" | "version-check" | "bump-release", round: number, failureText: string): string {
  const head = `你是 merge 发布流程的异常兜底修复 agent（第 ${round} 轮）。只处理下述白名单场景，修复后由流程重跑原脚本验证——你不得自报成功了事。${RESCUE_REDLINES}\n`;
  if (stage === "premerge") {
    return `${head}
场景：阶段 1 本地验证（pre-merge-check.sh）失败。工作目录 = ${featWt}（feature 分支 ${branchName}）。
允许动作：在该 worktree 内修复 lint / typecheck / quality-gates 检查类测试 / build 失败；修复后按全局提交策略 git add 精确路径 + commit（正常 pre-commit，英文 conventional message）+ git push github HEAD（脚本的「未推送 commits」检查要求推送；push 会触发 PR CI 重跑，时序自洽——后续 pr-merge 等待的是新一轮 CI）。
若失败项是「未提交变更」：只提交当前工作区已存在的改动，不得顺手改代码。
失败输出尾部：
${tailLines(failureText, 60)}
返回 RescueReport：action=fixed（已修复并提交推送）/ retry（未改动，建议直接重跑）/ escalate（不可自动修复）；summary=修复摘要；filesChanged=改动文件清单；residualRisk=残留风险（无则空串）。`;
  }
  if (stage === "version-check") {
    return `${head}
场景：阶段 3.5 版本校验（check-version-bump.sh）报「版本不匹配」。工作目录 = ${mainWt}。
允许动作仅限非破坏恢复：
- 若此前被手动 bump 过版本：cd ${mainWt} && pnpm version <最新正式 release 版本号> --no-git-tag-version 回退（最新正式 release 用 gh release view --repo zhushanwen321/tai-ji --json tagName 查询；两个 package.json 都需回退时另一个在 apps/electron 下同样执行）。
- prerelease（-beta.N）占用目标版本号、pre-release 测试未还原等其余情形：不得自行处置，返回 escalate 并写明现象。
失败输出尾部：
${tailLines(failureText, 40)}
返回 RescueReport：action=retry（已回退，建议重跑校验）/ escalate；summary/filesChanged/residualRisk 同上。`;
  }
  return `${head}
场景：阶段 4 版本 bump 的原子 commit 被 pre-commit 拦截。工作目录 = ${mainWt}。
允许动作：按钩子报错原文修复其点名的文件（如文档词表、格式问题），修复后单独 commit——必须 pathspec 限定提交：TAIJI_ALLOW_MAIN_COMMIT=1 git commit -m "<fix/docs 类英文 conventional message>" -- <修复文件路径…>（此刻暂存区滞留着两个 package.json 的 bump 改动，裸 git commit 会把它们卷入修复 commit、破坏 bump commit 只含两个 package.json 的原子语义；正常走 pre-commit）；不得 push（流程统一推送）。
修复完成后流程会重跑原子 bump commit。
失败输出尾部（commit 日志）：
${tailLines(failureText, 60)}
返回 RescueReport：action=fixed（已修复并单独 commit）/ retry / escalate；summary/filesChanged/residualRisk 同上。`;
}

// pi 壳 wfAgent 解析失败时的传回形态（zcode 侧不产生）：识别为无效返回走回喂重试，
// 不让平台差异中断流程
const invalidAskNote = (v: unknown): string => {
  const inv = (v as { __invalidAsk?: unknown })?.__invalidAsk;
  return typeof inv === "string" && inv !== "" ? `平台层返回无效（pi 壳解析失败）：${inv}` : "";
};

async function rescueOnce(stage: "premerge" | "version-check" | "bump-release", round: number, failureText: string, rerunHint: string): Promise<RescueReport> {
  const prompt = rescuePrompt(stage, round, failureText);
  const validate = (v: RescueReport): string => {
    if (v === null || typeof v !== "object") return "返回不是对象";
    const inv = invalidAskNote(v);
    if (inv !== "") return inv;
    if (v.action !== "fixed" && v.action !== "retry" && v.action !== "escalate") return `action 非法：${JSON.stringify(v.action)}（合法值 fixed/retry/escalate）`;
    if (typeof v.summary !== "string" || v.summary.trim() === "") return "summary 为空";
    if (!Array.isArray(v.filesChanged)) return "filesChanged 不是数组";
    if (typeof v.residualRisk !== "string") return "residualRisk 不是字符串（无残留风险填空串）";
    return "";
  };
  let lastErr = "";
  // 三个白名单场景各持字面 agent 名（第一个插值前的字面前缀互斥，GUI 泳道可区分）；
  // 分步赋值持引用以支持回喂（校验失败把错误清单发回同一 agent 重试一次）
  if (stage === "premerge") {
    const a = agent(`rescue-premerge-r${round}`, "merge 发布流程阶段 1 的兜底修复 agent，只在 feature worktree 内修门禁失败，严格遵守红线。");
    for (let attempt = 1; attempt <= 2; attempt++) {
      const v = await a.ask<RescueReport>(attempt === 1 ? prompt : `${prompt}\n\n上一次返回被判为无效（原因：${lastErr}）。重新输出有效 JSON。`);
      const err = validate(v);
      if (err === "") return v;
      lastErr = err;
    }
  } else if (stage === "version-check") {
    const a = agent(`rescue-version-r${round}`, "merge 发布流程阶段 3.5 的兜底恢复 agent，只做非破坏版本回退，严格遵守红线。");
    for (let attempt = 1; attempt <= 2; attempt++) {
      const v = await a.ask<RescueReport>(attempt === 1 ? prompt : `${prompt}\n\n上一次返回被判为无效（原因：${lastErr}）。重新输出有效 JSON。`);
      const err = validate(v);
      if (err === "") return v;
      lastErr = err;
    }
  } else {
    const a = agent(`rescue-bump-r${round}`, "merge 发布流程阶段 4 的兜底修复 agent，只修 pre-commit 拦截点名的文件，严格遵守红线。");
    for (let attempt = 1; attempt <= 2; attempt++) {
      const v = await a.ask<RescueReport>(attempt === 1 ? prompt : `${prompt}\n\n上一次返回被判为无效（原因：${lastErr}）。重新输出有效 JSON。`);
      const err = validate(v);
      if (err === "") return v;
      lastErr = err;
    }
  }
  throw new Escalation(`[rescue-${stage}-r${round}] 两次返回均无效：${lastErr}。恢复：${rerunHint}`);
}

// ── step wrapper：skipSteps 命中记 skipped；failure 短路后续 step；阶段边界由观测层
//    withStage 承载（fn 抛异常自动补 script-error end）──
async function step<T>(id: string, fn: () => Promise<T>): Promise<T | null> {
  if (skipSet.has(id)) {
    skippedSteps.push({ step: id, reason: "发起方 skipSteps 显式跳过（人工接管逃生舱）" });
    stages[id] = "skipped";
    return null;
  }
  if (failure !== null) return null;
  try {
    const r = await withStage(id, null, fn);
    if (stages[id] === undefined) stages[id] = "pass";
    return r;
  } catch (e) {
    failure = { step: id, error: e instanceof Error ? e.message : String(e) };
    stages[id] = "failed";
    return null;
  }
}

// main worktree 当前版本号（各 step 独立重取——skipSteps 跳步时状态不依赖前序 step）
async function readVersion(): Promise<string> {
  const r = await runNode(["-p", `require(${JSON.stringify(`${mainWt}/package.json`)}).version`]);
  const v = r.exitCode === 0 ? r.stdout.trim() : "";
  if (v === "") throw new Escalation(`无法读取 main worktree 版本号（${mainWt}/package.json）：${r.stderr.trim()}。恢复：确认 main worktree 存在且 package.json 完好后重新发起`);
  return v;
}

// ══ 15 step 主流程 ══

phase("发起前检查");
await step("preflight", async () => {
  const gh = await execCmd({ cwd: "main", argv: ["gh", "auth", "status"], timeoutMs: 60_000 });
  if (gh.exitCode !== 0) {
    throw new Escalation(`gh 未认证或不可用：${tailLines(gh.text, 10)}\n恢复：gh auth login 后重新发起`);
  }
  // pnpm 按脚本实际执行形态检查（argv 形态不加 PATH 前缀、走引擎 PATH）——缺位时
  // premerge 的 install/lint/build 与 pr-merge 的 pnpm 调用会全部 127，提前拦截
  const pnpm = await execCmd({ cwd: "main", argv: ["sh", "-c", "command -v pnpm"], timeoutMs: 30_000 });
  if (pnpm.exitCode !== 0 || pnpm.text.trim() === "") {
    throw new Escalation(`pnpm 不在 PATH（command -v pnpm 无命中）——后续 pre-merge-check.sh 的 install/lint/build 与 pr-merge 的 pnpm 调用将全部失败。恢复：把 pnpm 所在目录（如 ~/Library/pnpm）暴露到发起环境 PATH 后重新发起`);
  }
  const br = await execCmd({ cwd: "main", argv: ["git", "rev-parse", "--abbrev-ref", "HEAD"], timeoutMs: 60_000 });
  if (br.exitCode !== 0) {
    throw new Escalation(`main worktree 不可用（${mainWt}）：${tailLines(br.text, 10)}\n恢复：核对 workspace 布局（worktree list）后重新发起`);
  }
  log(`preflight 通过：gh 已认证；pnpm=${pnpm.text.trim().split("\n").pop() ?? "?"}；main worktree 当前分支=${br.text.trim().split("\n").pop() ?? "?"}`);
});

phase("初始化与 PR 发现");
await step("init", async () => {
  const r = await runRouted({
    routeKey: "init", cwd: "main",
    argv: ["bash", ".agents/skills/merge/scripts/init.sh", branchName],
    timeoutMs: 180_000,
    rerunHint: `cd ${mainWt} && bash .agents/skills/merge/scripts/init.sh ${branchName}（merge-state 占用时先按三查指引处置）`,
  });
  // 解析脚本结构化输出（WS_ROOT=/BRANCH_NAME=/PR_NUMBER= 三行，init.sh 固定打印；
  // 行首有两空格缩进是脚本真实格式——正则容错行首行尾空白，mock 测试按脚本原文对齐）
  const prMatch = /^[ \t]*PR_NUMBER=(\d+)[ \t]*$/m.exec(r.text);
  const discovered = prMatch !== null ? Number(prMatch[1]) : 0;
  if (discovered === 0) {
    // 协议异常 fail-fast：入参带了 prNumber 也不据此覆写——init 输出与协议不符时
    // 其余输出（PR 状态等）同样不可信
    throw new Escalation(`init.sh 成功但未解析到 PR_NUMBER${prNumber > 0 ? `（入参 prNumber=${prNumber} 不作依据）` : ""}——输出尾部：\n${tailLines(r.text, 20)}\n恢复：核对 feature 分支 PR 存在（gh pr view）后重新发起`);
  }
  if (prNumber > 0 && prNumber !== discovered) {
    throw new Escalation(`参数 prNumber=${prNumber} 与 init.sh 实测 PR_NUMBER=${discovered} 不一致——调用方意图不清，fail-fast。恢复：核对后重新发起`);
  }
  prNumber = discovered;
  log(`init 完成：PR #${prNumber}（${prUrl()}）`);
});

phase("commit 整理判定");
await step("squash-check", async () => {
  if (squashMode === "skip") {
    squashNote = "squashMode=skip，发起方显式跳过 commit 整理";
    stages["squash-check"] = "skipped";
    log(`[squash-check] ${squashNote}`);
    return;
  }
  const baseR = await execCmd({ cwd: "feature", argv: ["git", "merge-base", "github/main", "HEAD"], timeoutMs: 60_000 });
  if (baseR.exitCode !== 0) throw new Escalation(`git merge-base 失败：${tailLines(baseR.text, 10)}`);
  let base = baseR.text.trim().split("\n")[0] ?? "";
  // 硬约束 7：区间内 merge commit 不碰——重划整理起点到最新一笔 merge commit 之后
  // （git log 新→旧：首行才是最新 merge；取末行=最旧 merge 会漏掉更晚的 merge，
  //   区间内残留 merge 时人工照计划整理会改写 merge 结构）
  const merges = await execCmd({ cwd: "feature", argv: ["git", "log", "--merges", "--format=%H %s", `${base}..HEAD`], timeoutMs: 60_000 });
  const mergeLines = merges.text.trim().split("\n").filter(Boolean);
  if (mergeLines.length > 0) {
    base = (mergeLines[0] ?? "").split(" ")[0] ?? base;
    log(`[squash-check] 区间内存在 ${mergeLines.length} 笔 merge commit——整理起点重划到最新一笔 merge commit 之后（硬约束 7）`);
  }
  const logR = await execCmd({ cwd: "feature", argv: ["git", "log", "--no-merges", "--format=%h%x09%an%x09%s", `${base}..HEAD`], timeoutMs: 60_000 });
  const commits = logR.text.trim().split("\n").filter(Boolean);
  if (commits.length === 0) {
    squashNote = "整理起点后无本工作流 commit（区间内全是 merge commit 或分支无新提交）——无需整理";
    log(`[squash-check] ${squashNote}`);
    return;
  }
  // 硬约束 5：作者集非单一 = 存在他人 commit → 停下询问用户（机器判定，不派 agent）
  const authors = new Set(commits.map((l) => l.split("\t")[1] ?? ""));
  if (authors.size > 1) {
    throw new Escalation(`区间内存在多个作者的 commit（${[...authors].join("、")}）——硬约束 5「他人 commit 不动」，禁止自动改写。恢复：人工判定整理范围后按 SKILL 阶段 0.5 人工段执行`);
  }
  interface SquashVerdict {
    action: "no-need" | "needs-squash" | "uncertain";
    reason: string;
    /** needs-squash 时必填：重组计划表（每行一笔：保留 / 折入 <目标> / 重写 message + 一句理由） */
    plan: string;
  }
  const prompt = `你是 merge 发布流程阶段 0.5 的 commit 粒度判定 agent。判定下列 commit 序列是否需要重组（只判定，不执行任何 git 写操作）。

判定清单（SKILL 阶段 0.5，依据 = 逻辑边界而非行数笔数）：
该合并（折入）：wip/fixup/typo/lint fix/review feedback 类且归属某笔逻辑单元；流程自动生成的小笔（lockfile/snapshot/registry 同步等）是上一笔的直接后果；文档同步小笔随对应代码 commit；对更早一笔的直接修正且无独立 revert 价值；相邻两笔同 type 同 scope 合并后 message 更清晰。
必须保留：两笔 type 不同；一笔可独立 revert 且有独立场景；纯改名/纯移动与内容修改分笔；合并后 message 含两个以上 type 语义；被外部 cherry-pick 依赖的笔。
兜底：拿不准 → 保留（合并是单向损失信息的操作，保留可逆）——此时返回 no-need 或 uncertain，不得为整洁而合并。

commit 清单（${commits.length} 笔，hash<TAB>author<TAB>message，区间 = 整理起点..HEAD）：
${commits.join("\n")}

返回 SquashVerdict：action=no-need（粒度已合理，直接放行）/ needs-squash（确需整理，plan 填完整重组计划表）/ uncertain（拿不准——流程按无需整理放行并披露你的理由）；reason=一句判定理由；plan=no-need/uncertain 时填空串。`;
  const a = agent("squash-plan", "merge 发布流程的 commit 粒度判定 agent，只判不执行，拿不准一律倾向保留。");
  // 校验失败回喂一次（畸形返回不得静默按无需整理放行）
  const validateVerdict = (v: SquashVerdict): string => {
    if (v === null || typeof v !== "object") return "返回不是对象";
    const inv = invalidAskNote(v);
    if (inv !== "") return inv;
    if (v.action !== "no-need" && v.action !== "needs-squash" && v.action !== "uncertain") return `action 非法：${JSON.stringify(v.action)}（合法值 no-need/needs-squash/uncertain）`;
    if (typeof v.reason !== "string" || v.reason.trim() === "") return "reason 为空";
    if (typeof v.plan !== "string") return "plan 不是字符串（no-need/uncertain 填空串）";
    if (v.action === "needs-squash" && v.plan.trim() === "") return "action=needs-squash 但 plan 为空——须填完整重组计划表，拿不准应返回 uncertain";
    return "";
  };
  let verdict: SquashVerdict | null = null;
  let vErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const v = await a.ask<SquashVerdict>(attempt === 1 ? prompt : `${prompt}\n\n上一次返回被判为无效（原因：${vErr}）。重新输出有效 JSON。`);
    const err = validateVerdict(v);
    if (err === "") { verdict = v; break; }
    vErr = err;
  }
  if (verdict === null) {
    throw new Escalation(`squash-plan 两次返回均无效：${vErr}\n恢复：人工按 SKILL 阶段 0.5 判定清单完成整理判定后重新发起（无需整理用 squashMode=skip；已人工整理则 skipSteps 含 squash-check）`);
  }
  if (verdict.action === "needs-squash") {
    squashNote = `需整理：${verdict.reason}`;
    failure = {
      step: "squash-check",
      status: "needs-squash-approval",
      error: `commit 整理计划待批准（${verdict.reason}）：\n${verdict.plan}\n\n批准路径：主 agent 按 SKILL 阶段 0.5 人工段执行整理（路线 A reset --soft / 路线 B 非交互 rebase，机械校验全过），完成后重新发起本 workflow 并在 args.skipSteps 中含 squash-check`,
    };
    stages["squash-check"] = "needs-approval";
    return;
  }
  squashNote = `${verdict.action === "uncertain" ? "拿不准按保留放行" : "无需整理"}：${verdict.reason}`;
  log(`[squash-check] ${squashNote}`);
});

phase("本地验证");
await step("premerge", async () => {
  await runRouted({
    routeKey: "premerge", rescueStage: "premerge", cwd: "main",
    argv: ["bash", ".agents/skills/merge/scripts/pre-merge-check.sh", featWt],
    logName: "premerge", timeoutMs: 7_200_000,
    rerunHint: `cd ${mainWt} && bash .agents/skills/merge/scripts/pre-merge-check.sh ${featWt}（日志 ${runLogDir}/premerge.log）`,
  });
  log("premerge 通过（依赖/typecheck+检查/lint/build/git 状态）");
});

phase("Dev-Link 清理");
await step("prune-devlink", async () => {
  const r = await execCmd({ cwd: "main", argv: ["bash", ".agents/skills/merge/scripts/prune-dev-link.sh", featWt], timeoutMs: 120_000 });
  if (r.exitCode !== 0) {
    throw new Escalation(`prune-dev-link.sh 失败（exit ${r.exitCode}，参数/定位错误）：\n${tailLines(r.text, 15)}\n恢复：cd ${mainWt} && bash .agents/skills/merge/scripts/prune-dev-link.sh ${featWt}`);
  }
  log(`dev-link 清理：${tailLines(r.text, 3)}`);
});

phase("PR CI 与合并");
await step("pr-merge", async () => {
  await runRouted({
    routeKey: "pr-merge", cwd: "main",
    argv: ["bash", ".agents/skills/merge/scripts/pr-merge.sh", String(prNumber)],
    logName: "pr-merge", timeoutMs: 2_700_000,
    rerunHint: `cd ${mainWt} && bash .agents/skills/merge/scripts/pr-merge.sh ${prNumber}（幂等，已合并的 PR 会跳过合并步骤；日志 ${runLogDir}/pr-merge.log）`,
  });
  log(`PR #${prNumber} 已合并，本地 main 已同步`);
});

phase("Post-merge CI");
await step("post-merge-ci", async () => {
  const fetchR = await execCmd({ cwd: "main", argv: ["git", "fetch", "github"], timeoutMs: 180_000 });
  if (fetchR.exitCode !== 0) throw new Escalation(`git fetch 失败：${tailLines(fetchR.text, 10)}`);
  const shaR = await execCmd({ cwd: "main", argv: ["git", "rev-parse", "github/main"], timeoutMs: 60_000 });
  mergeSha = shaR.text.trim().split("\n")[0] ?? "";
  if (mergeSha === "") throw new Escalation("无法解析 github/main 的 commit SHA");
  await runRouted({
    routeKey: "post-merge-ci", cwd: "main",
    argv: ["bash", ".agents/skills/merge/scripts/wait-for-ci.sh", mergeSha],
    extended: { argv: ["bash", ".agents/skills/merge/scripts/wait-for-ci.sh", mergeSha, "--timeout", "3600"], timeoutMs: 4_200_000 },
    logName: "post-merge-ci", timeoutMs: 2_700_000,
    rerunHint: `cd ${mainWt} && bash .agents/skills/merge/scripts/wait-for-ci.sh ${mergeSha}（超时可加 --timeout 3600；日志 ${runLogDir}/post-merge-ci.log）`,
    passCheck: async (r) => {
      // no-runs 放行补验（仅当 wait-for-ci 以「未检测到 CI workflow」语义放行时触发；
      // 正常 CI 通过路径不做额外查询）：独立 gh 复核——真无 run 仅披露放行；查到 run
      // = 放行判定与事实不符（CI 可能晚于 30s 轮询窗口触发），停回人工判定 run 结论
      if (!r.text.includes("未检测到 CI workflow")) return;
      const runs = await execCmd({ cwd: "main", argv: ["gh", "run", "list", "--commit", mergeSha, "--repo", "zhushanwen321/tai-ji", "--limit", "10", "--json", "databaseId,status,conclusion"], timeoutMs: 60_000 });
      if (runs.exitCode !== 0) {
        throw new Escalation(`wait-for-ci 以「未检测到 CI」放行，但补验的 gh run list 查询失败（网络/限流/登录态）——无法确认放行成立：${tailLines(runs.text, 10)}\n恢复：人工 gh run list --commit ${mergeSha} --repo zhushanwen321/tai-ji 核查后重跑本 step`);
      }
      const trimmed = runs.text.trim();
      if (trimmed !== "[]" && trimmed !== "") {
        throw new Escalation(`wait-for-ci 以「未检测到 CI」放行，但 gh 复核发现该 commit 存在 CI run——放行判定与事实不符（CI 可能晚于 30s 轮询窗口触发）：\n${tailLines(runs.text, 20)}\n恢复：gh run view <id> 核查结论——绿则重跑本 step，红则回开发线修复`);
      }
      log(`[post-merge-ci] 补验：该 commit 无任何 CI run——按「无 CI 放行」披露（ci.yml 路径过滤预期内，如纯 docs 改动），不等同于 CI 通过`);
    },
  });
  log(`post-merge CI 通过（${mergeSha.slice(0, 10)}）`);
});

phase("版本校验");
await step("version-check", async () => {
  await runRouted({
    routeKey: "version-check", rescueStage: "version-check", cwd: "main",
    argv: ["bash", "scripts/check-version-bump.sh"],
    logName: "version-check", timeoutMs: 900_000,
    rerunHint: `cd ${mainWt} && bash scripts/check-version-bump.sh（版本不匹配时按 SKILL 阶段 3.5 四条恢复路径处置）`,
  });
  log("版本校验通过（代码版本 == 最新正式 release，可安全 bump）");
});

phase("e2e 圈定");
await step("e2e-select", async () => {
  const r = await runNode(["scripts/select-affected-e2e.mjs", "--release"], { timeoutMs: 120_000, cwd: "main" });
  if (r.exitCode !== 0) {
    throw new Escalation(`select-affected-e2e.mjs --release 失败（发布触发清单圈定失败，不得静默跳过）：\n${tailLines(`${r.stdout}\n${r.stderr}`, 20)}\n恢复：cd ${mainWt} && node scripts/select-affected-e2e.mjs --release 排查后重跑`);
  }
  e2eNote = tailLines(r.stdout, 40);
  log(`[e2e-select] 发布触发的 L3 真机资产清单（只圈不跑——A2 烧真实 token 须用户当场确认，SKILL 阶段 3.7 默认语义；如需执行由主 agent 按清单跑）：\n${e2eNote}`);
});

phase("版本 bump 与发布");
await step("bump-release", async () => {
  const v0 = await readVersion();
  // 幂等预检：远端 tag 已存在 = bump+push 已完成（上次 run 在 verify 或之后中断）→ 直接 verify。
  // 基线查询 fail-closed：任一通道查询失败都不许在基线未知时盲目续跑（apply/bump 非幂等，
  // 盲跑会产生双 bump 污染 main 历史）；「release not found」= 仓库尚无任何正式 release
  // （首次发布场景），属正常无基线——与 check-version-bump.sh 的同类语义一致
  const remoteTag = await execCmd({ cwd: "main", argv: ["git", "ls-remote", "github", `refs/tags/v${v0}`], timeoutMs: 60_000 });
  if (remoteTag.exitCode !== 0) {
    throw new Escalation(`幂等预检：远端 tag 查询失败（git ls-remote），无法判定 bump+push 是否已完成：\n${tailLines(remoteTag.text, 10)}\n恢复：网络恢复后重跑本 step（自查：cd ${mainWt} && git ls-remote github refs/tags/v${v0}）`);
  }
  const tagExists = remoteTag.text.trim() !== "";
  if (!tagExists) {
    const latest = await execCmd({ cwd: "main", argv: ["gh", "release", "view", "--repo", "zhushanwen321/tai-ji", "--json", "tagName", "-q", ".tagName"], timeoutMs: 60_000 });
    if (latest.exitCode !== 0 && !latest.text.includes("release not found")) {
      throw new Escalation(`幂等预检：最新 release 基线查询失败（gh，网络/限流/登录态），无法判定版本中间态：\n${tailLines(latest.text, 10)}\n恢复：gh 恢复后重跑本 step（自查：cd ${mainWt} && gh release view --repo zhushanwen321/tai-ji --json tagName -q .tagName）`);
    }
    const latestTag = latest.exitCode === 0 ? latest.text.trim() : "";
    if (latestTag !== "" && latestTag !== `v${v0}`) {
      throw new Escalation(`版本中间态：main 当前版本 ${v0} ≠ 最新正式 release ${latestTag}，且远端无 v${v0} tag——可能是上次 bump 到一半（commit 未 push / tag 未打）。禁止盲目续跑（apply/bump 非幂等）。恢复：cd ${mainWt} && git log --oneline -3 && git status，人工判定续跑或还原后重新发起`);
    }
    const br = await execCmd({ cwd: "main", argv: ["git", "branch", "--show-current"], timeoutMs: 60_000 });
    if (br.text.trim() !== "main") {
      // SKILL 阶段 4 批准恢复：main worktree 必须在 main 分支
      const co = await execCmd({ cwd: "main", argv: ["git", "checkout", "main"], timeoutMs: 120_000 });
      if (co.exitCode !== 0) throw new Escalation(`main worktree 不在 main 分支且 checkout 失败：${tailLines(co.text, 10)}`);
    }
    const bumpRoot = await execCmd({ cwd: "main", rawScript: "pnpm version patch --no-git-tag-version", logName: "bump-root", timeoutMs: 300_000 });
    if (bumpRoot.exitCode !== 0) throw new Escalation(`根包版本 bump 失败：\n${tailLines(bumpRoot.text, 20)}`);
    const bumpApp = await execCmd({ cwd: "main", rawScript: "cd apps/electron && pnpm version patch --no-git-tag-version", logName: "bump-app", timeoutMs: 300_000 });
    if (bumpApp.exitCode !== 0) throw new Escalation(`apps/electron 版本 bump 失败：\n${tailLines(bumpApp.text, 20)}`);
    const version = await readVersion();
    if (version === v0) throw new Escalation(`版本 bump 未生效（仍 ${v0}）——人工核查 pnpm version 输出`);
    // 原子提交：两个 package.json 同一 commit（--no-git-tag-version 的意义所在）
    const add = await execCmd({ cwd: "main", rawScript: "git add package.json apps/electron/package.json", timeoutMs: 60_000 });
    if (add.exitCode !== 0) throw new Escalation(`git add 失败：${tailLines(add.text, 10)}`);
    await runRouted({
      routeKey: "bump-commit", rescueStage: "bump-release", cwd: "main",
      rawScript: `TAIJI_ALLOW_MAIN_COMMIT=1 git commit -m ${shq(`chore: bump version to ${version}`)}`,
      logName: "bump-commit", timeoutMs: 7_200_000,
      rerunHint: `cd ${mainWt} && git add package.json apps/electron/package.json && TAIJI_ALLOW_MAIN_COMMIT=1 git commit -m "chore: bump version to ${version}"（日志 ${runLogDir}/bump-commit.log）`,
    });
    const tagR = await execCmd({ cwd: "main", rawScript: `git tag ${shq(`v${version}`)}`, timeoutMs: 60_000 });
    if (tagR.exitCode !== 0) throw new Escalation(`git tag v${version} 失败：${tailLines(tagR.text, 10)}`);
    // tag 指向 push 前核对（本地拦截坏 tag，不等 push 后 CI 兜底）
    const check = await execCmd({ cwd: "main", rawScript: `[ "$(git rev-parse ${shq(`v${version}^{commit}`)})" = "$(git rev-parse HEAD)" ]`, timeoutMs: 60_000 });
    if (check.exitCode !== 0) throw new Escalation(`tag v${version} 未指向 HEAD——禁止 push（SKILL 阶段 4 硬约束）。恢复：人工核对 tag 与 HEAD`);
    releaseTag = `v${version}`;
    await runRouted({
      routeKey: "push", cwd: "main", rawScript: "git push github HEAD",
      logName: "push-main", timeoutMs: 600_000,
      rerunHint: `cd ${mainWt} && git push github HEAD（日志 ${runLogDir}/push-main.log）`,
    });
    await runRouted({
      routeKey: "push", cwd: "main", rawScript: `git push github ${shq(releaseTag)}`,
      logName: "push-tag", timeoutMs: 600_000,
      rerunHint: `cd ${mainWt} && git push github ${releaseTag}（日志 ${runLogDir}/push-tag.log）`,
    });
    log(`bump+push 完成：${releaseTag}`);
  } else {
    releaseTag = `v${v0}`;
    log(`[bump-release] 幂等预检命中：远端已存在 ${releaseTag}——bump+push 已完成，直接进 verify`);
  }
  await runRouted({
    routeKey: "verify-release", cwd: "main",
    argv: ["bash", "scripts/verify-ci-release.sh", releaseTag],
    extended: { argv: ["bash", "scripts/verify-ci-release.sh", releaseTag, "--ci-timeout", "60"], timeoutMs: 4_500_000 },
    logName: "verify-release", timeoutMs: 2_700_000,
    rerunHint: `cd ${mainWt} && bash scripts/verify-ci-release.sh ${releaseTag}（日志 ${runLogDir}/verify-release.log；禁止重打同版本 tag）`,
  });
  log(`release CI 与产物验证通过（${releaseTag}）`);
});

phase("npm 发布检测");
await step("npm-detect", async () => {
  // 4N 移交检测（辅助披露步——失败降级为 unknown 并在终态醒目披露，不阻塞主链；
  // 检测遗漏的代价 = 主 agent 人工核查，不是发布错误）
  const mc = await execCmd({ cwd: "main", argv: ["gh", "pr", "view", String(prNumber), "--repo", "zhushanwen321/tai-ji", "--json", "mergeCommit", "-q", ".mergeCommit.oid"], timeoutMs: 60_000 });
  const mergeCommit = mc.exitCode === 0 ? mc.text.trim() : "";
  if (mergeCommit === "") {
    npmHandoff = { detected: false, detail: `PR merge commit 查询失败——extensions 改动检测未完成，主 agent 必须人工核查是否需要 4N（gh pr view ${prNumber} --json mergeCommit）` };
    log(`[npm-detect] WARN: ${npmHandoff.detail}`);
    stages["npm-detect"] = "unknown";
    return;
  }
  const diff = await execCmd({ cwd: "main", argv: ["git", "diff", "--name-only", `${mergeCommit}^1`, mergeCommit], timeoutMs: 60_000 });
  const files = diff.text.trim().split("\n").filter(Boolean);
  const touched = files.filter((f) => f.startsWith("extensions/"));
  if (diff.exitCode !== 0) {
    npmHandoff = { detected: false, detail: `merge commit diff 失败——extensions 改动检测未完成，主 agent 必须人工核查是否需要 4N（git diff --name-only ${mergeCommit}^1 ${mergeCommit}）` };
    stages["npm-detect"] = "unknown";
    return;
  }
  if (touched.length === 0) {
    npmHandoff = { detected: false, detail: "本次 PR 无 extensions/ 改动——4N 不需要" };
    log("[npm-detect] 无 extensions/ 改动，4N 跳过");
    return;
  }
  const cv = await execCmd({ cwd: "main", argv: ["bash", "scripts/check-version-changes.sh", `${mergeCommit}^1..${mergeCommit}`], timeoutMs: 120_000 });
  npmHandoff = {
    detected: true,
    detail: `本次 PR 含 ${touched.length} 个 extensions/ 文件改动——4N npm 发布线移交主 agent 人工段（4N.2 人工定 type）。check-version-changes 输出（exit ${cv.exitCode}）：\n${tailLines(cv.text, 60)}`,
  };
  stages["npm-detect"] = "handed-off";
  log(`[npm-detect] ${npmHandoff.detail}`);
});

phase("Release Notes 撰写");
await step("notes", async () => {
  const version = await readVersion();
  const tag = `v${version}`;
  // 素材机器取数（agent 只写文）：上一版本 tag（--match 过滤 npm-* tag 空间污染）+ commit 清单
  const prev = await execCmd({ cwd: "main", argv: ["git", "describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", `${tag}^`], timeoutMs: 60_000 });
  const prevTag = prev.exitCode === 0 ? prev.text.trim() : "";
  const range = prevTag !== "" ? `${prevTag}..${tag}` : tag;
  const logR = await execCmd({ cwd: "main", argv: ["git", "log", "--no-merges", "--format=%h %s", range], timeoutMs: 60_000 });
  const commits = tailLines(logR.text, 200);
  const notesFile = `${runLogDir}/release-notes-${version}.md`;
  interface NotesDraft {
    filePath: string;
    summary: string;
  }
  const prompt = `你是 merge 发布流程的 Release Notes 撰写 agent。为 ${tag} 撰写中英双语 Release Notes 并写入 ${notesFile}。

必读两级规范（先读再写）：
1. 全局写作规范（SSOT）：~/.agents/guide/release-notes.md
2. 项目特化补充：${mainWt}/docs/release-notes.md

硬性格式（流程会机器校验，不合规将回你重写）：
- <!-- LANG:en --> 在前、<!-- LANG:zh --> 在后，标记独占一行
- 全文不得含 emoji
- 三节结构（feat → 新增功能、perf → 功能优化、fix → 修复缺陷、breaking → 重大变更），条目面向用户（30 字模糊化、排序与合并按全局规范），不写内部实现细节

素材：版本 ${tag}，上一版本 ${prevTag || "（首个 release）"}，PR #${prNumber}，commit 清单（${range}）：
${commits}

完成后返回 NotesDraft：filePath=写入的文件绝对路径（必须为 ${notesFile}）；summary=一句内容摘要。`;
  const a = agent("notes-draft", "merge 发布流程的 Release Notes 撰写 agent，严格按两级规范写中英双语 notes。");
  let lastErr = "";
  let drafted = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const draft = await a.ask<NotesDraft>(attempt === 1 ? prompt : `${prompt}\n\n上一次产出未通过机器校验（原因：${lastErr}）。修正后重写同一文件并返回。`);
    const draftInv = invalidAskNote(draft);
    if (draftInv !== "") {
      lastErr = draftInv;
      continue;
    }
    if (draft.filePath !== notesFile) {
      lastErr = `filePath 不符（${draft.filePath}）`;
      continue;
    }
    const body = await readFileViaNode(notesFile);
    if (body === "") {
      lastErr = "notes 文件为空或不存在";
      continue;
    }
    const missing: string[] = [];
    if (!body.includes("<!-- LANG:en -->")) missing.push("<!-- LANG:en -->");
    if (!body.includes("<!-- LANG:zh -->")) missing.push("<!-- LANG:zh -->");
    if (missing.length > 0) {
      lastErr = `缺少双语标记：${missing.join("、")}`;
      continue;
    }
    // emoji 门禁（与 release.sh 写入前同一实现，fail-closed：检测执行失败同样拦截）
    const emoji = await execCmd({ cwd: "main", argv: ["python3", ".githooks/check_doc_emoji.py", notesFile], timeoutMs: 60_000 });
    if (emoji.exitCode !== 0) {
      lastErr = `emoji 校验未通过（exit ${emoji.exitCode}）：${tailLines(emoji.text, 10)}`;
      continue;
    }
    drafted = true;
    break;
  }
  if (!drafted) {
    throw new Escalation(`Release Notes 三次产出均未通过机器校验：${lastErr}\n恢复：主 agent 按两级规范手写双语 notes 后 gh release edit ${tag} --notes-file <文件>，然后重新发起 + skipSteps 含 notes`);
  }
  const edit = await execCmd({ cwd: "main", argv: ["gh", "release", "edit", tag, "--repo", "zhushanwen321/tai-ji", "--notes-file", notesFile], timeoutMs: 120_000 });
  if (edit.exitCode !== 0) {
    throw new Escalation(`gh release edit 失败：${tailLines(edit.text, 15)}\n恢复：cd ${mainWt} && gh release edit ${tag} --notes-file ${notesFile}`);
  }
  const url = await execCmd({ cwd: "main", argv: ["gh", "release", "view", tag, "--repo", "zhushanwen321/tai-ji", "--json", "url", "-q", ".url"], timeoutMs: 60_000 });
  releaseUrl = url.exitCode === 0 ? url.text.trim() : "";
  log(`Release Notes 已写入（双语标记 + emoji 校验通过）：${releaseUrl || tag}`);
});

phase("交付物复核");
await step("verify", async () => {
  const version = await readVersion();
  // 阶段 6 独立复核（SKILL 硬门禁「不可跳过」——bump-release 内已验一次，此处为终局确认）
  await runRouted({
    routeKey: "verify-release", cwd: "main",
    argv: ["bash", "scripts/verify-ci-release.sh", `v${version}`],
    extended: { argv: ["bash", "scripts/verify-ci-release.sh", `v${version}`, "--ci-timeout", "60"], timeoutMs: 4_500_000 },
    logName: "verify-final", timeoutMs: 2_700_000,
    rerunHint: `cd ${mainWt} && bash scripts/verify-ci-release.sh v${version}`,
  });
  log("阶段 6 交付物复核通过");
  // 状态机终态落盘（对齐人工路径 release 阶段的 released 写入：终态后不再参与 12h
  // 发布互斥，否则每次发布后 12h 内下一轮 init 必 BUSY 需人工解锁；辅助通道——
  // 写失败仅告警不阻塞，同 state.mjs 语义）
  const ws = await runNode([
    "--input-type=module", "-e",
    "const{pathToFileURL}=await import(\"node:url\");const a=process.argv.slice(1);const{writeMergeState}=await import(pathToFileURL(a[0]).href);const p={tag:a[2],stage:\"released\",releasedAt:new Date().toISOString()};if(a[3])p.releaseUrl=a[3];process.exit(writeMergeState(a[1],p)===null?1:0)",
    `${mainWt}/scripts/merge/lib/state.mjs`, wsRoot, `v${version}`, releaseUrl,
  ], { timeoutMs: 60_000 });
  if (ws.exitCode !== 0) {
    log(`[verify] WARN: merge-state 终态写入失败（不阻塞；12h 内下一轮 init 会 BUSY，届时确认收官后人工删 ${wsRoot}/.merge-state/current.json）：${tailLines(`${ws.stdout}\n${ws.stderr}`, 5)}`);
  } else {
    log("merge-state 终态落盘：stage=released（下一轮发布互斥解除）");
  }
});

phase("GitCode 镜像同步");
await step("gitcode-sync", async () => {
  const version = await readVersion();
  const tag = `v${version}`;
  // GITCODE_TOKEN 经 zsh 交互式配置链可见（v0.11.4 实测：直接 bash 载荷 exit 2 无日志）
  const syncArgv = (sub: string): string[] => ["zsh", "-ic", `cd ${shq(mainWt)} && GITCODE_REPO=qq_18433817/tai-ji node scripts/gitcode-release-sync.mjs ${sub}`];
  await runRouted({
    routeKey: "gitcode-sync", cwd: "main", maxRetries: 1,
    argv: syncArgv(`sync-from-github ${tag}`),
    logName: "gitcode-assets", timeoutMs: 3_600_000,
    rerunHint: `cd ${mainWt} && GITCODE_REPO=qq_18433817/tai-ji node scripts/gitcode-release-sync.mjs sync-from-github ${tag}（断点续传幂等；GITCODE_TOKEN 仅 zsh 交互式配置链可见——在 zsh -ic '…' 同款链内执行或先 export；日志 ${runLogDir}/gitcode-assets.log）`,
  });
  log("GitCode 附件镜像完成");
  const readme = await runNode([".agents/skills/merge/scripts/update-readme-install.mjs", version], { timeoutMs: 60_000, cwd: "main" });
  if (readme.exitCode !== 0) {
    throw new Escalation(`README 安装版本更新失败：\n${tailLines(`${readme.stdout}\n${readme.stderr}`, 15)}\n恢复：cd ${mainWt} && node .agents/skills/merge/scripts/update-readme-install.mjs ${version}`);
  }
  const diff = await execCmd({ cwd: "main", rawScript: "git diff README.md README_EN.md", timeoutMs: 60_000 });
  if (diff.text.trim() === "") {
    log("README 已是该版本（无变化，跳过 commit/push）");
  } else {
    // 「人工过目 git diff」在 workflow 形态 = diff 摘要入终态报告披露（流程偏离登记）
    readmeDiffNote = tailLines(diff.text, 40);
    log(`README 版本 diff（披露代人工过目）：\n${readmeDiffNote}`);
    // commit 与 push 分两段：commit 非幂等（重跑撞 nothing to commit）不挂 retry，
    // push 单独挂网络类 retry——commit 成功 + push 网络失败后重试只重推不重建 commit
    const readmeCommit = await execCmd({
      cwd: "main",
      rawScript: `git add README.md README_EN.md && TAIJI_ALLOW_MAIN_COMMIT=1 git commit -m ${shq(`docs: bump install version to v${version} in README`)}`,
      logName: "readme-commit", timeoutMs: 7_200_000,
    });
    if (readmeCommit.exitCode !== 0) {
      throw new Escalation(`README 版本更新 commit 失败：\n${tailLines(readmeCommit.text, 20)}\n恢复：cd ${mainWt} && git add README.md README_EN.md && TAIJI_ALLOW_MAIN_COMMIT=1 git commit -m "docs: bump install version to v${version} in README"（日志 ${runLogDir}/readme-commit.log）`);
    }
    await runRouted({
      routeKey: "push", cwd: "main", rawScript: "git push github HEAD:main",
      logName: "readme-push", timeoutMs: 600_000,
      rerunHint: `cd ${mainWt} && git push github HEAD:main（commit 已完成只差推送；日志 ${runLogDir}/readme-push.log）`,
    });
  }
  await runRouted({
    routeKey: "gitcode-sync", cwd: "main", maxRetries: 1,
    argv: syncArgv("push-repo --ref-source github"),
    logName: "gitcode-repo", timeoutMs: 3_600_000,
    rerunHint: `cd ${mainWt} && GITCODE_REPO=qq_18433817/tai-ji node scripts/gitcode-release-sync.mjs push-repo --ref-source github（--ref-source 本地必传；GITCODE_TOKEN 仅 zsh 交互式配置链可见——在 zsh -ic '…' 同款链内执行或先 export；日志 ${runLogDir}/gitcode-repo.log）`,
  });
  log("GitCode 仓库镜像完成（引用集逐条比对由脚本保证）");
  // 终端用户视角匿名下载链路冒烟（302→CDN→Range 206）
  const dmgUrl = `https://gitcode.com/qq_18433817/tai-ji/releases/download/v${version}/TaiJi-${version}-mac-arm64.dmg`;
  const curl = await execCmd({ cwd: "main", argv: ["curl", "-sL", "-o", "/dev/null", "-w", "%{http_code}", "-r", "0-1048575", "--max-time", "60", dmgUrl], timeoutMs: 90_000 });
  if (curl.text.trim() !== "206") {
    throw new Escalation(`GitCode 匿名下载冒烟失败（HTTP ${curl.text.trim() || "无响应"}，期望 206）：${dmgUrl}\n恢复：回 6.5.1 重跑附件镜像（断点续传）后重新验证；重新发起本 workflow 时 skipSteps 跳过已完成 step`);
  }
  log("GitCode 匿名下载冒烟通过（206）");
});

phase("清理 worktree");
await step("cleanup", async () => {
  // 零未决失败机器门禁（SKILL 阶段 7 [MANDATORY]）：skipSteps 接管过 squash-check 以外
  // 的 step = 该环节未在流程内验证完成 → 禁止清理，保留现场
  const takenOver = skippedSteps.filter((s) => s.step !== "squash-check");
  if (takenOver.length > 0) {
    failure = {
      step: "cleanup",
      status: "needs-human",
      error: `清理门禁拦截：以下 step 被人工接管跳过、未在流程内验证完成——${takenOver.map((s) => s.step).join("、")}。\nworktree 删除不可逆，带病清理 = 永久失去修复现场。恢复：确认这些环节已完成并验证后，按 SKILL 阶段 7 人工执行清理（cd ${mainWt} && bash .agents/skills/merge/scripts/remove-worktree.sh ${branchName} --force --skip-sync），或经用户明确授权带病收尾`,
    };
    stages["cleanup"] = "needs-human";
    return;
  }
  // backup 分支逐个判定（ahead=0 才删——并行会话在途备份可能非零，保留并呈报）
  const backups = await execCmd({ cwd: "main", argv: ["git", "for-each-ref", "refs/heads/backup*", "--format=%(refname:short)"], timeoutMs: 60_000 });
  const kept: string[] = [];
  for (const b of backups.text.trim().split("\n").filter(Boolean)) {
    const ahead = await execCmd({ cwd: "main", argv: ["git", "rev-list", "--count", `main..${b}`], timeoutMs: 60_000 });
    if (ahead.text.trim() === "0") {
      const del = await execCmd({ cwd: "main", argv: ["git", "branch", "-D", b], timeoutMs: 60_000 });
      if (del.exitCode === 0) {
        log(`已删备份分支 ${b}（ahead=0，全历史已在 main）`);
      } else {
        // 删除失败如实呈报并保留——成功日志不得先行于事实
        kept.push(b);
        log(`备份分支 ${b} 删除失败（保留；exit ${del.exitCode}）：${tailLines(del.text, 5)}`);
      }
    } else {
      kept.push(b);
      log(`保留 backup 分支 ${b}（领先 main ${ahead.text.trim()} 笔——并行在途或未吸收，随总结呈报）`);
    }
  }
  const rm = await execCmd({ cwd: "main", argv: ["bash", ".agents/skills/merge/scripts/remove-worktree.sh", branchName, "--force", "--skip-sync"], logName: "cleanup", timeoutMs: 600_000 });
  if (rm.exitCode !== 0) {
    throw new Escalation(`remove-worktree.sh 失败（exit ${rm.exitCode}）：\n${tailLines(rm.text, 30)}\n恢复：按 SKILL「阶段 7 后 bash 工具失效处理」节区分 rm 失败与 prune 失败两类处置（prune 失败须手工补跑 worktree prune + branch -D）；本 workflow 经 world.run 执行，删除 feature worktree 不影响后续命令`);
  }
  log(`worktree 与分支已清理：${branchName}${kept.length > 0 ? `；保留 backup 分支：${kept.join("、")}` : ""}`);
});

// ══ 终态 ══
const fail = failure as Failure | null;
const status = fail !== null ? (fail.status ?? "failed") : "released";
const doneSteps = STEP_IDS.filter((id) => stages[id] === "pass");
report({ stage: "terminal", status, failedStep: fail?.step ?? null, tag: releaseTag || null });

const summaryLines = [
  `# merge 发布流程：${status}`,
  "",
  `- PR: ${prUrl() || "（未知）"}`,
  `- tag: ${releaseTag || "（未产生）"}${releaseUrl !== "" ? `\n- release: ${releaseUrl}` : ""}${mergeSha !== "" ? `\n- mergeSha: ${mergeSha}` : ""}`,
  `- 各 step：${STEP_IDS.map((id) => `${id}=${stages[id] ?? "未执行"}`).join("，")}`,
  `- commit 整理：${squashNote}`,
  `- e2e 圈定：真机未执行（默认语义，主 agent 定夺）${e2eNote !== "（未执行）" ? `\n${e2eNote}` : ""}`,
  `- 4N npm 发布线：${npmHandoff.detected ? "移交主 agent 人工段" : npmHandoff.detail}${npmHandoff.detected ? `\n${npmHandoff.detail}` : ""}`,
  readmeDiffNote !== "" ? `- README 版本 diff（披露代人工过目，SKILL 6.5.2 等价物）：\n${readmeDiffNote}` : "- README 版本 diff: 未产生（已是目标版本或未执行到 6.5.2）",
  skippedSteps.length > 0 ? `- skippedSteps:\n${skippedSteps.map((s) => `  - ${s.step}: ${s.reason}`).join("\n")}` : "- skippedSteps: 无",
  rescueLog.length > 0 ? `- rescue 记录：\n${rescueLog.map((r) => `  - ${r.step} r${r.round}: [${r.action}] ${r.summary}${r.residualRisk !== "" ? `（残留风险：${r.residualRisk}）` : ""}`).join("\n")}` : "- rescue 记录：无",
  "",
  fail !== null ? `## 失败详情\n\n${fail.error}` : "## 收尾\n\n主链全绿，worktree 已清理。",
];
try {
  await artifact.markdown("summary", summaryLines.join("\n"), {
    title: `merge ${status}${releaseTag !== "" ? `：${releaseTag}` : ""}`,
    description: (fail !== null ? fail.error.split("\n")[0] : `${releaseTag} 发布主链完成`).slice(0, 500),
    primary: true,
  });
} catch {
  log("WARN: 终态摘要 artifact 发布失败（不影响流程结果）");
}
await obsCloseExecution(status);

const nextActionParts: string[] = [];
if (npmHandoff.detected) nextActionParts.push("执行 4N npm 发布人工段（按 npm-detect 的 check-version-changes 输出人工定 type，走 SKILL 阶段 4N）");
if (e2eNote !== "（未执行）") nextActionParts.push("定夺是否执行 3.7 圈出的真机 e2e（A2 烧真实 token 须用户当场确认）");
nextActionParts.push("向用户输出三节合并总结（事故 / 流程偏离 / 遗留债务），README diff 与 rescue 记录随偏离节披露");
const recoveryText = `处置后重新发起本 workflow（CreateWorkflow path 指向 <workspace>/.agents/workflows/merge.dwf.ts，args.worktree 同前）；已完成的 step 在 args.skipSteps 中跳过（本次已通过：${doneSteps.join("/") || "无"}；squash-check 之外被跳过的 step 会触发清理门禁 needs-human）。run 被中断（非 failed）时优先 ResumeWorkflowRun（journal 重放，已成功步骤零重跑）。`;

if (fail !== null) {
  return {
    status,
    failedStep: fail.step,
    error: fail.error,
    prUrl: prUrl() || undefined,
    tag: releaseTag || undefined,
    stages,
    skippedSteps,
    rescues: rescueLog,
    npmHandoff,
    recovery: recoveryText,
    nextAction: nextActionParts.join("；"),
  };
}
return {
  status: "released" as const,
  prUrl: prUrl(),
  tag: releaseTag,
  releaseUrl: releaseUrl || undefined,
  mergeSha,
  stages,
  skippedSteps,
  rescues: rescueLog,
  squash: squashNote,
  npmHandoff,
  e2e: e2eNote,
  nextAction: nextActionParts.join("；"),
};
