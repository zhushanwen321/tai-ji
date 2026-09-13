'use strict';
/*
 * pr-lifecycle 状态核心（纯逻辑库）——设计：docs/design/pr-lifecycle-workflow.md §3.4/§3.5/§3.7（已删除，git 可追溯）
 *
 * 本模块禁止直接产生外部效应：fs / pid 探测 / 时间 / 随机源全部经 io 注入，
 * 禁止引用 workerData 与任何 worker 注入全局（入口 pr-lifecycle.js 组装 io，
 * 测试 test/run-tests.js 以 mock io 驱动）。
 *
 * io 契约：
 *   args              发起参数（$ARGS 原样透传；CLI 形态下值为字符串）
 *   repoRoot          repo/worktree 绝对路径（入口解析；state.repo 与守卫 2 的比对基准）
 *   pid               当前进程 pid
 *   fs                { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
 *                       unlinkSync, openSync, writeSync, closeSync, readdirSync, realpathSync }
 *   sh(cmd, args, opts) => { code, stdout, stderr }（lib.createSh 产物；不 throw）
 *   readEngineState(engineRunId) => { ok: true, status } | { ok: false, reason }
 *                                     读引擎 state 文件末行 state.status（P5 实证 JSONL）
 *   probePid(pid) => 'alive' | 'dead'（process.kill(pid, 0) 探测，信号 0 无副作用）
 *   log(...msg)
 *   now() => Date
 *   randomToken() => 4 位随机串（runId 的 rand4 段）
 *   steps             step 注册表 [{ id, run(ctx) }]
 *                       ctx = { state, params, runIdDir, io, saveCheckpoint() }
 */

const path = require('node:path');

const STATE_VERSION = 1;
const LOCK_RETRIES_MAX = 2;

// §3.4-(2) state schema 顶层字段（顺序 = createState 的写盘顺序；测试逐字段断言）
const STATE_FIELDS = [
  'stateVersion',
  'runId',
  'repo',
  'branch',
  'base',
  'baseHash',
  'pid',
  'engineRunId',
  'params',
  'status',
  'failedStep',
  'error',
  'lastHead',
  'result',
  'steps',
];

// 引擎 state 末行 state.status 的已知终态集合（P5 实证：running / done）。
// fail-closed：集合外的值（含缺失/undefined）一律按 running 处理，
// 防引擎格式演进导致旧 run 仍存活时被误放行、双 run 并发互写。
const ENGINE_TERMINAL_STATUS = new Set(['done', 'failed', 'aborted', 'cancelled', 'error']);

/* ── §3.7 错误规格表文案模板 ─────────────────────────────────────────── */

const MSG = {
  stateMissing: (runId) =>
    `runId ${runId} 无效：state 不存在、损坏或版本不兼容；从头执行请去掉 runId 参数`,
  repoMismatch: (stateRepo, curRepo) =>
    `该 runId 属于另一仓库/worktree（state.repo=${stateRepo}，当前=${curRepo}）；请切回发起时的 worktree 后重新带 runId 发起`,
  branchMismatch: (runId, branch) =>
    `runId ${runId} 属于分支 ${branch}；切回该分支后 resume，如需对当前分支跑全流程请不传 runId 起新 run`,
  activeEngine: (engineRunId, status) =>
    `原 run 仍在进行（engineRunId=${engineRunId} status=${status}）；如需接管请先 abort 原 run，之后重新带 runId 发起`,
  activePid: (pid) =>
    `原 run 仍在进行（pid=${pid}；引擎 state 文件不可读，已降级 pid 探测）；如需接管请先终止该进程；` +
    `若疑似 pid 复用，先用 \`ps -p ${pid} -o command=\` 核实非本 run 进程（终态/无关）后终止之，或手工编辑 state 清除 pid 字段后重试`,
  dirtyWorktree: (list) =>
    `存在未提交改动：\n${list}\n若为中断残留（cr-fix/simplify 的半成品），人工检查后经 \`git add <显式路径> && git commit\` 落盘或 \`git checkout -- <路径>\` 还原后 resume`,
  externalChanges: (from, to) =>
    `HEAD 存在外部变更（${from} → ${to}）。确认外部改动后带 allowExternalChanges=true 重新发起（walker 从断点 step 重跑，新 commit 自然进入检查范围），或不传 runId 起新 run`,
  allDoneHeadMoved: (runId, from, to, freshCmd) =>
    `本 run ${runId} 已完成；新产生的 commit（${from} → ${to}）未经任何门禁，请不传 runId 起新 run` +
    `（allowExternalChanges 在此场景无效）。新 run 命令：${freshCmd}`,
  freshConcurrent: (runId) =>
    `已有进行中的 run ${runId}；如需从头再来请先 abort 原 run，或带其 runId resume`,
  lockUnreadable: (lockPath) =>
    `互斥锁存在但内容不可读（${lockPath}）；人工确认无进行中 run 后，手工删除该文件重试`,
  lockRetryExhausted: (n) =>
    `互斥锁接管重试 ${n} 次仍被占用（并发发起过密或持锁进程正在重建）；稍后重试，若持续存在按「${MSG.lockUnreadable('.review/pr-workflow/lock')}」处置`,
  gitFailed: (args, stderr) =>
    `git ${args.join(' ')} 失败：${String(stderr || '').trim() || '无 stderr'}；确认当前目录是有效 git 仓库`,
  baseUnresolvable: (base, stderr) =>
    `base "${base}" 无法解析为 commit（${String(stderr || '').trim()}）；确认 base 分支/ref 名正确`,
  badParam: (name, why) =>
    `参数 ${name} 非法：${why}；对照脚本 @pi-meta 的 parameters 声明修正发起参数`,

  /* ── u2：PR 阶段 steps（§3.7 错误规格表） ── */
  preflightNoCommits: (base) =>
    `分支相对 base ${base} 无 commits；确认当前分支正确，或先 commit 后重新发起`,
  preflightGhAuth: (detail) =>
    `gh 未认证（${String(detail || '').trim().split('\n')[0] || 'gh auth status 失败'}）；运行 \`gh auth login\` 后重新发起`,
  preflightFallow: (detail) =>
    `fallow 不可用（${String(detail || '').trim().split('\n')[0] || 'fallow --version 失败'}）；运行 \`npm i -g fallow\` 后重新发起`,
  preflightSummary: (items) =>
    `preflight 前置条件未过：\n${items.map((s) => `- ${s}`).join('\n')}`,
  gateToolError: (name, out) =>
    `gate ${name} exit 2（工具错误，不自动重试）：\n${tailLines(out, 15)}\n按脚本输出指引处理（多为配置漂移/记账不闭合，需人看）`,
  gateExhausted: (name, rounds, out) =>
    `${name} 经 ${rounds} 轮修复子循环仍未通过。最后一轮输出摘要：\n${tailLines(out, 15)}\n人工修复后经 \`git add <显式路径> && git commit\` 落盘，再用 resumeCommand 续跑（resume 后本 step 重跑，gate 面对已 commit 的改动正常判定）`,
  gateFixLeftDirty: (list) =>
    `fix agent 返回后存在未提交改动（第 1 次止损，不烧后续轮次）：\n${list}\n脚本不自动 commit（不判断改动归属）；人工检查后显式路径 commit 或 checkout 还原，再 resume（resume 后本 step 重跑）`,
  agentFailed: (what, err) =>
    `${what} 调用失败：${err}；环境问题排除后 resume`,
  agentInvalidOutput: (what, value) =>
    `${what} 返回不符合契约：${typeof value === 'string' ? value.slice(0, 200) : JSON.stringify(value).slice(0, 200)}；resume 重跑本 step`,
  changesetMissingWarn: () =>
    `changeset 条件输入缺失：static-gate outputs 无 changesetWarn（state 来自旧版本脚本或被篡改）；从头执行请去掉 runId 参数`,
  skillYamlFail: (out) =>
    `skill YAML 校验失败（硬校验不修，不自动重试）：\n${tailLines(out, 15)}\n按校验输出修复 SKILL.md 后 resume`,
  prSubmitPrereq: () =>
    `pr-submit 前置产物缺失：pr-meta 未 done 或无 bodyFile；resume 会从断点重跑 pr-meta`,
  prSubmitUrlMissing: (out) =>
    `pr-submit exit 0 但输出未解析到合法 pr_url（期望 https://github.com/<owner>/<repo>/pull/<n>）。实际输出：\n${tailLines(out, 10)}\n检查 pr-submit.sh 输出形态后 resume`,
  prSubmitExit2: (detail) =>
    `pr-submit exit 2（git push 失败）：检查远端连通性/分支保护后 resume（PR 已建时重跑幂等更新）。${tailLines(detail, 10)}`,
  prSubmitExit3: (detail) =>
    `pr-submit exit 3（gh 已认证但调用失败）：查 \`gh auth status\` / API 限流后 resume。${tailLines(detail, 10)}`,
  prSubmitExit5: (detail) =>
    `pr-submit exit 5（title/body 文件缺失）：pr-meta 产物异常：检查 runId 目录下 pr-title.txt/pr-body.md，resume 重跑。${tailLines(detail, 10)}`,

  /* ── u3：门禁 steps（§3.7） ── */
  constraintsFail: (out) =>
    `select-constraints.mjs 失败（exit 非 0）：\n${tailLines(out, 15)}\n检查 docs/constraints.json 与脚本输出后 resume`,
  constraintsMissing: (p) =>
    `constraints step exit 0 但未产出 ${p}；检查脚本版本与输出后 resume`,
  finalGatesRealPiMissing: (reason) =>
    `real-pi 凭证预检未过：${reason}\n补 pi 凭证（三源：env API key / auth.json / models.json，探测链对齐 packages/runtime/src/__tests__/equivalence/pi-fixture.ts 的 REAL_PI_READY）后 resume；不得凭 skip 宣布 PASS`,
  finalGatesRealPiSkip: (markers) =>
    `final-gates：test:runtime 输出检出 real-pi skip 标记（${markers.join(' | ')}）——真实凭证子集未跑，验收不完整；补 pi 凭证后 resume，不得凭 skip 宣布 PASS`,
  finalGatesDirtyTail: (list) =>
    `final-gates 收尾防线：存在未提交改动，修复可能静默丢失（与 structured-output 历史事故同型）：\n${list}\n经 \`git add <显式路径> && git commit\` 落盘后 resume`,

  /* ── u4：cr-fix step（§3.7 cr-fix 两行 + §3.4-(3)-5 恢复粒度） ── */
  crFixNoBatch1: (dir, reviewers) =>
    `cr-fix batch1 组装失败：${dir} 下无匹配的 review-*.md${reviewers ? `（reviewers 裁剪词：${reviewers.join(',')}）` : ''}。` +
    `确认当前 worktree 存在 .agents/skills/pr-cr-fix/agents/review-*.md，或修正 reviewers 裁剪词后 resume`,
  crFixStuck: (terminated, reportRef, message) =>
    `cr-fix nested loop 终态 ${terminated}：读 ${reportRef}\n` +
    `处置分支：① 判定为 reviewer 误报 → resume 并带 skipSteps:["cr-fix"]（人工接管，终态 scriptResult 逐项披露）；` +
    `② 真问题 → 修复 commit 后 resume（cr-fix 整体重跑，已 fix 的问题不会再被报出，通常 1-2 轮收敛）。\n` +
    `nested message：${message || '（无）'}`,
  crFixRetryExhausted: (terminated, attempts) =>
    `cr-fix nested loop 连续 ${attempts} 次 ${terminated}（环境类失败，已自动重试 1 次）：检查 pi 凭证 / 模型配额 / 引擎状态后 resume（cr-fix 整体重跑）`,
  crFixUnknownTerminated: (terminated, reportRef) =>
    `cr-fix 终态未知值 "${terminated}"（引擎契约演进，fail-closed 按 failed 处置）：读 ${reportRef} 人工判定后 resume，或带 skipSteps:["cr-fix"] 接管`,

  /* ── Gate B S1：repoRoot 仓库根校验 ── */
  repoRootInvalid: (repoRoot, stderr) =>
    `repoRoot "${repoRoot}" 不是有效 git 仓库（git rev-parse --show-toplevel 失败：${tailLines(stderr, 3) || '无 stderr'}）。` +
    `恢复：--repo 传仓库根绝对路径（即 .agents/skills/pr-cr-fix/workflows/pr-lifecycle.js 所在仓的根）后重新发起`,
  repoRootNotToplevel: (repoRoot, top) =>
    `repoRoot "${repoRoot}" 不是仓库根（git toplevel = "${top}"）。恢复：--repo 传仓库根绝对路径后重新发起`,

  /* ── u5：simplify step（§3.6 D6 / §3.7 simplify 行） ── */
  simplifyContractMissing: (p) =>
    `simplify 契约文件缺失：${p}。该文件是 simplify step 的固化契约（摘录 code-simplify 铁律与覆盖声明），缺失时 step 拒绝执行；恢复：确认 .agents/skills/pr-cr-fix/agents/simplify-apply.md 存在于当前 worktree 后 resume`,
  simplifyLeftDirty: (list, applied) =>
    `simplify agent 返回后存在未提交改动（agent 声称 applied=${applied}）：\n${list}\n` +
    `${applied > 0 ? 'agent 声称已应用但未 commit = 半成品' : 'agent 违规改动代码（无应用授权却留下改动）'}；` +
    `查看 runId 目录 simplify-report.md 后人工处置（显式路径 commit 或还原），再 resume 或带 skipSteps:["simplify"] 接管`,
  simplifyReportMissing: (p) =>
    `simplify agent 未产出报告文件（${p}）；无法支撑 skippedSteps 披露与事后审阅，查看 agent 输出后 resume`,
  simplifyInvalidApplied: (v) =>
    `simplify agent 返回 applied 非法（${v}）：applied 必须为非负整数且不超过 proposals 总数；resume 重跑本 step`,
};

function tailLines(text, n) {
  const lines = String(text || '').trimEnd().split('\n');
  return lines.length <= n ? String(text || '').trimEnd() : lines.slice(-n).join('\n');
}

// porcelain 输出过滤掉脚本自持目录 .review/（design 假设目标仓 gitignore 含 /.review/；
// 未 gitignore 的仓里脚本写 state 会自挡工作区干净检查——结构性排除，语义只强不弱）
function worktreeDirt(porcelainOut) {
  return String(porcelainOut || '')
    .split('\n')
    .map((s) => s.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.slice(3).trim().replace(/^"|"$/g, '').startsWith('.review/'))
    .join('\n');
}

// gate 修复子循环的 fixPrompt（§3.5：修完自行 commit，message 与 cr-fix 的 fix commit 区分）
function gateFixPrompt(stepId, round, res) {
  return [
    `你是 gate 修复 agent。workflow step "${stepId}" 第 ${round} 轮验证失败，输出摘要（末 60 行）：`,
    tailLines(`${res.stderr || ''}\n${res.stdout || ''}`, 60),
    '',
    '要求：',
    '1. 修复上述输出的全部问题，只改与失败直接相关的文件。',
    `2. 修完自行 commit：git add <显式路径> && git commit -m "fix: gate ${stepId} round ${round}"。`,
    '3. 禁止 git add -A / git add .（会把工作区无关改动一起提交）。',
    '4. 修不完的部分在回复中明确说明，不要静默跳过。',
  ].join('\n');
}

// resumeCommand（§3.4-(1)：失败终态必须含可直接复制执行的恢复命令）
function resolveZswCli(io) {
  // 候选①：zsw main worktree bin（Gate B 实测可用源；core 契约脚本只能被 ≥1.2.0 引擎执行）
  const mainWorktreeCli = path.join(io.homedir(), 'Code', 'zcode-plugin-workspace', 'main', 'z-subagent-workflow', 'bin', 'zsw.js');
  try {
    if (io.fs.existsSync(mainWorktreeCli)) return mainWorktreeCli;
  } catch { /* 落候选② */ }
  // 候选②：插件 cache glob，版本数值最高且 ≥1.2.0——cache 里的 1.0.0 是旧 run(ctx) 契约，
  // 执行/校验 core 契约脚本必失败（workerData 未定义），必须过滤
  const base = path.join(io.homedir(), '.zcode', 'cli', 'plugins', 'cache', 'zcode-plugin-workspace', 'z-subagent-workflow');
  let versions = [];
  try {
    versions = io.fs.readdirSync(base);
  } catch {
    versions = [];
  }
  const minParts = [1, 2, 0];
  const geMin = (parts) => {
    for (let i = 0; i < minParts.length; i++) {
      if ((parts[i] || 0) !== minParts[i]) return (parts[i] || 0) > minParts[i];
    }
    return true;
  };
  const candidates = versions
    .map((v) => {
      const cliPath = path.join(base, v, 'bin', 'zsw.js');
      let ok = false;
      try { ok = io.fs.existsSync(cliPath); } catch { ok = false; }
      return { v, cliPath, ok, parts: v.split('.').map((n) => parseInt(n, 10) || 0) };
    })
    .filter((c) => c.ok && geMin(c.parts))
    .sort((a, b) => {
      for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
        const d = (b.parts[i] || 0) - (a.parts[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    });
  return candidates.length > 0 ? candidates[0].cliPath : null;
}

const ZSW_CLI_PLACEHOLDER = '<zsw-cli>（占位：zsw CLI 路径按 SKILL 路径 2 获取，形如 ~/.zcode/cli/plugins/cache/zcode-plugin-workspace/z-subagent-workflow/<版本>/bin/zsw.js）';

// resumeCommand（§3.4-(1)：失败终态必须含可直接复制执行的恢复命令——zsw CLI 真形态，非伪命令）
function resumeCommand(io, repo, runId) {
  const cli = resolveZswCli(io) || ZSW_CLI_PLACEHOLDER;
  // workdir 是引擎 RUN_ENVELOPE_KEYS 保留键不进 $ARGS——脚本读仓库根必须走 --repo（Gate B S1）；
  // resume 时 repo = state.repo，一致性由守卫 2 校验
  const base = `node ${cli} workflow --workflow ${repo}/.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js --workdir ${repo} --repo ${repo}`;
  return runId ? `${base} --runId ${runId}` : base;
}

/* ── 守卫失败载体 ────────────────────────────────────────────────────── */

class GuardError extends Error {
  constructor(message, { runId = null, resumeCommand = undefined } = {}) {
    super(message);
    this.name = 'GuardError';
    this.runId = runId;
    this.resumeCommand = resumeCommand;
  }
}

/* ── 参数合并语义（§3.5：发起值覆盖脚本默认值；CLI 字符串形态防御性归一） ── */

function asString(v, name, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new GuardError(MSG.badParam(name, '应为字符串'));
}

function asStringArray(v, name, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (Array.isArray(v)) {
    return v.map((x) => {
      if (typeof x !== 'string' && typeof x !== 'number') {
        throw new GuardError(MSG.badParam(name, '数组元素应为字符串'));
      }
      return String(x);
    });
  }
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return asStringArray(parsed, name, dflt);
    } catch { /* 非 JSON，按逗号分割 */ }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  throw new GuardError(MSG.badParam(name, '应为字符串数组或逗号分隔字符串'));
}

function asNumber(v, name, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new GuardError(MSG.badParam(name, `应为数字，得到 ${JSON.stringify(v)}`));
  return n;
}

function asBool(v, name, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new GuardError(MSG.badParam(name, '应为布尔值（true/false）'));
}

function asEnum(v, name, allowed, dflt) {
  const s = asString(v, name, dflt);
  if (!allowed.includes(s)) {
    throw new GuardError(MSG.badParam(name, `应为 ${allowed.map((a) => `"${a}"`).join(' | ')} 之一，得到 "${s}"`));
  }
  return s;
}

/**
 * @pi-meta parameters 声明的全部脚本级参数（timeoutMs/workdir/model 等引擎级
 * 参数不在此列——RUN_ENVELOPE_KEYS 不进 $ARGS）。CLI 透传值为字符串时在此归一。
 */
function normalizeParams(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    runId: asString(raw.runId, 'runId', null) || null,
    repo: asString(raw.repo, 'repo', null) || null, // Gate B S1：目标仓库根（脚本侧仅透传留存；io.repoRoot 由入口 resolveRepoRoot 解析）
    aggregatorModel: asString(raw.aggregatorModel, 'aggregatorModel', null) || null, // Gate B S1：缺省不传 = nested loop 跟随 run 模型（zai-coding-cn 在 pi 侧不存在，硬编码已致 aggregator-failure×2）
    base: asString(raw.base, 'base', 'main'),
    reviewers: asStringArray(raw.reviewers, 'reviewers', null),
    maxRounds: asNumber(raw.maxRounds, 'maxRounds', 10),
    simplifyMode: asEnum(raw.simplifyMode, 'simplifyMode', ['apply', 'report'], 'apply'),
    skipSteps: asStringArray(raw.skipSteps, 'skipSteps', []),
    allowExternalChanges: asBool(raw.allowExternalChanges, 'allowExternalChanges', false),
  };
}

/* ── runId（§3.4-(1)：prw-<yyyymmdd>-<HHMMSS>-<rand4>，脚本自生成） ──── */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function makeRunId(now, randomToken) {
  const d = now();
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `prw-${date}-${time}-${randomToken()}`;
}

function isValidRunId(runId) {
  return /^prw-\d{8}-\d{6}-[a-z0-9]{4}$/.test(runId);
}

/* ── state（§3.4-(2)：schema v1 + 原子写） ───────────────────────────── */

function createState({ runId, repo, branch, base, baseHash, pid, engineRunId, params, head }) {
  const state = {
    stateVersion: STATE_VERSION,
    runId,
    repo,
    branch,
    base,
    baseHash,
    pid,
    engineRunId,
    params,
    status: 'running',
    failedStep: null,
    error: null,
    lastHead: head,
    result: null,
    steps: {},
  };
  return state;
}

let tmpSeq = 0;

/**
 * 原子落盘：tmp 写全量 + rename 原子替换（§3.4-(2)）。
 * 每次 checkpoint 顺带刷新 lastHead = 当前 HEAD（读失败保留原值，不阻断落盘）。
 */
function saveState(io, state, stateFile) {
  const headRes = io.sh('git', ['rev-parse', 'HEAD']);
  if (headRes.code === 0 && headRes.stdout.trim()) state.lastHead = headRes.stdout.trim();
  const tmp = `${stateFile}.tmp-${io.pid}-${tmpSeq++}`;
  io.fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  io.fs.renameSync(tmp, stateFile);
}

/* ── sh() 封装（§3.5：execFileSync + 参数数组 + maxBuffer ≥64MB + 显式 cwd） ── */

const SH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * 确定性命令封装工厂。入口传真实 execFileSync；测试传 spy。
 * 约定：cmd/args 严格数组形态，绝不拼接 shell 字符串；失败不 throw，
 * 统一归一为 { code, stdout, stderr }（P4：maxBuffer 显式 64MB，防插桩长输出炸默认 1MB）。
 */
function createSh({ execFileSync, defaultCwd, maxBufferBytes = SH_MAX_BUFFER_BYTES }) {
  return function sh(cmd, args, opts = {}) {
    try {
      const stdout = execFileSync(cmd, args, {
        cwd: opts.cwd || defaultCwd,
        maxBuffer: maxBufferBytes,
        encoding: 'utf8',
      });
      return { code: 0, stdout: typeof stdout === 'string' ? stdout : '', stderr: '' };
    } catch (e) {
      return {
        code: typeof e.status === 'number' ? e.status : (e.code === 'ENOENT' ? 127 : -1),
        stdout: typeof e.stdout === 'string' ? e.stdout : '',
        stderr: typeof e.stderr === 'string' && e.stderr ? e.stderr : String((e && e.message) || e),
      };
    }
  };
}

/* ── git 只读解析 ────────────────────────────────────────────────────── */

function gitSnapshot(io) {
  const repoRes = io.sh('git', ['rev-parse', '--show-toplevel']);
  if (repoRes.code !== 0) throw new GuardError(MSG.gitFailed(['rev-parse', '--show-toplevel'], repoRes.stderr));
  const branchRes = io.sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRes.code !== 0) throw new GuardError(MSG.gitFailed(['rev-parse', '--abbrev-ref', 'HEAD'], branchRes.stderr));
  const headRes = io.sh('git', ['rev-parse', 'HEAD']);
  if (headRes.code !== 0) throw new GuardError(MSG.gitFailed(['rev-parse', 'HEAD'], headRes.stderr));
  return {
    repo: repoRes.stdout.trim(),
    branch: branchRes.stdout.trim(),
    head: headRes.stdout.trim(),
  };
}

function resolveBaseHash(io, base) {
  const res = io.sh('git', ['rev-parse', `${base}^{commit}`]);
  if (res.code !== 0) throw new GuardError(MSG.baseUnresolvable(base, res.stderr));
  return res.stdout.trim();
}

/* ── 活性守卫（§3.4-(4)：双通道 fail-closed） ─────────────────────────── */

/**
 * 主通道：读引擎 state 文件末行 status——running 或未知/缺失值一律视为
 * 进行中（fail-closed）；明确终态放行。
 * 降级通道：文件不可读/缺失时 probePid(pid)，死 → 放行（log 标注降级），
 * 活 → fail-fast（文案带 pid 复用人工出口）。
 */
function assertNotActive(io, engineRunId, pid, label) {
  label = label || '原 run';
  if (engineRunId) {
    const es = io.readEngineState(engineRunId);
    if (es && es.ok) {
      if (!ENGINE_TERMINAL_STATUS.has(es.status)) {
        // 主通道非终态（running/未知）：running 判定的权威性以「记录进程仍活着」为前提。
        // Gate B S2：CLI 本地 run 被 kill -9 时宿主与引擎同死，引擎 state 文件必然停留在
        // running（daemon 未运行时 abort 出口也不可达）——pid 死亡即「state 必然过期」的
        // 可靠信号，与引擎自身把遗留 running 收编 failed 的崩溃恢复方向一致。
        const pidAlive = (typeof pid === 'number' && pid > 0) ? io.probePid(pid) === 'alive' : null;
        if (pidAlive === false) {
          io.log(`[liveness] 引擎 state 停留在 running（${engineRunId} status=${es.status}）但记录进程已死（pid=${pid}，CLI 本地 kill 的典型形态，daemon 崩溃同理）→ 判定原 run 已死，接管放行（${label}）`);
          return;
        }
        // pid 存活（daemon 活着且 run 在跑）或无有效 pid（无从判定）：维持 fail-closed
        throw new GuardError(MSG.activeEngine(engineRunId, es.status == null ? '<missing>' : es.status));
      }
      return; // 明确终态 → 放行
    }
    io.log(`[liveness] 引擎 state 不可读（${(es && es.reason) || 'unknown'}），降级 pid 探测（${label} pid=${pid}）`);
  } else if (pid) {
    io.log(`[liveness] 无 engineRunId，直接降级 pid 探测（${label} pid=${pid}）`);
  }
  if (typeof pid === 'number' && pid > 0) {
    if (io.probePid(pid) === 'alive') {
      throw new GuardError(MSG.activePid(pid));
    }
    io.log(`[liveness] 降级通道：pid=${pid} 已退出，放行（${label}）`);
  }
  // 无 engineRunId 且无有效 pid：无从判定也无需判定（fresh 首跑等场景）
}

/* ── 互斥锁（§3.4-(1)：O_EXCL 原子创建；EEXIST 读锁内容过活性复查） ──── */

function lockPathOf(stateDir) {
  return path.join(stateDir, 'lock');
}

function writeLockContent(io, lockPath, runId, engineRunId) {
  io.fs.writeFileSync(lockPath, JSON.stringify({
    runId: runId || null,
    pid: io.pid,
    engineRunId: engineRunId || null,
    createdAt: io.now().toISOString(),
  }, null, 2));
}

function acquireLock(io, stateDir, engineRunId) {
  const lockPath = lockPathOf(stateDir);
  for (let attempt = 0; attempt <= LOCK_RETRIES_MAX; attempt++) {
    let fd;
    try {
      fd = io.fs.openSync(lockPath, 'wx'); // O_EXCL：原子创建，唯一持有者
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        let info = null;
        try {
          info = JSON.parse(io.fs.readFileSync(lockPath, 'utf8'));
        } catch { info = null; }
        if (!info || typeof info !== 'object') {
          // 空锁（创建方 write 前被读）或损坏：fail-closed，交人工
          throw new GuardError(MSG.lockUnreadable(lockPath));
        }
        assertNotActive(io, info.engineRunId, info.pid, '互斥锁持有者');
        io.log(`[lock] 残留锁持有人已终态/退出（runId=${info.runId} pid=${info.pid}），接管重建`);
        io.fs.unlinkSync(lockPath);
        continue; // 重建
      }
      throw e;
    }
    try {
      io.fs.writeSync(fd, JSON.stringify({
        runId: null, // fresh 时 runId 未生成，生成后经 updateLockContent 回填
        pid: io.pid,
        engineRunId: engineRunId || null,
        createdAt: io.now().toISOString(),
      }, null, 2));
    } finally {
      io.fs.closeSync(fd);
    }
    return lockPath;
  }
  throw new GuardError(MSG.lockRetryExhausted(LOCK_RETRIES_MAX));
}

function releaseLock(io, lockPath) {
  try {
    io.fs.unlinkSync(lockPath);
  } catch (e) {
    io.log(`[lock] 锁删除失败（${(e && e.message) || e}）；残留锁将由下次发起的活性复查接管`);
  }
}

/* ── latest 指针 + fresh 并发防护（§3.4-(1)） ────────────────────────── */

function latestPathOf(stateDir) {
  return path.join(stateDir, 'latest');
}

function readLatest(io, stateDir) {
  try {
    const content = io.fs.readFileSync(latestPathOf(stateDir), 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
}

function writeLatest(io, stateDir, runId) {
  io.fs.writeFileSync(latestPathOf(stateDir), `${runId}\n`);
}

// fresh 并发防护：读 latest 指针对应 run 的 state，对其 engineRunId/pid 过活性守卫
function guardFreshConcurrent(io, stateDir) {
  const latest = readLatest(io, stateDir);
  if (!latest) return;
  let prevState = null;
  try {
    prevState = JSON.parse(io.fs.readFileSync(path.join(stateDir, latest, 'state.json'), 'utf8'));
  } catch {
    prevState = null;
  }
  if (!prevState || typeof prevState !== 'object') return; // 旧 state 已不可读，无从判定（锁兜底互斥）
  try {
    assertNotActive(io, prevState.engineRunId, prevState.pid, `latest 指向的 run ${latest}`);
  } catch (e) {
    if (e instanceof GuardError) {
      // fresh 并发语义文案（带 runId），活性细节并入括号（§3.4-(1)）
      throw new GuardError(`${MSG.freshConcurrent(latest)}（${String(e.message).trim()}）`, { runId: latest });
    }
    throw e;
  }
  io.log(`[fresh] latest 指向的 run ${latest} 已终态/退出（status=${prevState.status}），允许新建`);
}

/* ── 终态组装（§3.1 scriptResult.json） ──────────────────────────────── */

function collectSkippedSteps(state) {
  const skipped = [];
  for (const id of Object.keys(state.steps)) {
    const rec = state.steps[id];
    if (rec && rec.status === 'skipped') {
      skipped.push({ step: id, reason: rec.reason || 'unspecified' });
    }
  }
  return skipped;
}

// premerge marker 行解析（pr-pre-merge.sh write_result_marker 写 shell 形态 `result="PASS"`，
// 非 JSON——readJsonFileQuiet 按 JSON 读会恒解析失败使防御分支不可达）
function readPremergeMarker(io, repoRoot) {
  try {
    const raw = io.fs.readFileSync(path.join(repoRoot, '.review', 'premerge-result'), 'utf8');
    const m = raw.match(/result="([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// 终态展示字段聚合（outputs 契约：§3.4-(2)）
function stepOutputs(state, stepId) {
  const rec = state.steps[stepId];
  return (rec && rec.outputs) || null;
}

function buildAwaitingPushResult(state) {
  const prSubmit = stepOutputs(state, 'pr-submit') || {};
  const crFix = stepOutputs(state, 'cr-fix') || {};
  const simplify = stepOutputs(state, 'simplify');
  const coverage1 = stepOutputs(state, 'coverage-1') || {};
  const finalGates = stepOutputs(state, 'final-gates') || {};
  return {
    status: 'awaiting-push',
    runId: state.runId,
    prUrl: prSubmit.prUrl || null,
    terminated: crFix.terminated || null,
    simplify: simplify ? `applied:${simplify.applied != null ? simplify.applied : 0}/proposals:${simplify.proposals != null ? simplify.proposals : 0}` : null,
    gates: {
      coverage: finalGates.coverageVerdict != null ? finalGates.coverageVerdict : (coverage1.coverageVerdict || null),
      metrics: finalGates.metricsVerdict || null,
      premerge: finalGates.premergeResult || null,
    },
    skippedSteps: collectSkippedSteps(state),
  };
}

function buildFailedResult(io, state, failedStep, error) {
  return {
    status: 'failed',
    runId: state.runId,
    failedStep: failedStep || null,
    error: error || null,
    resumeCommand: resumeCommand(io, state.repo, state.runId),
    skippedSteps: collectSkippedSteps(state),
  };
}

function guardFailResult(io, guardErr, fallbackRunId, repoRoot) {
  const runId = guardErr.runId != null ? guardErr.runId : fallbackRunId;
  return {
    status: 'failed',
    runId,
    failedStep: null,
    error: guardErr.message,
    resumeCommand: guardErr.resumeCommand !== undefined
      ? guardErr.resumeCommand
      : resumeCommand(io, repoRoot, runId),
    skippedSteps: [],
  };
}

/* ── resume walker（§3.4-(3) 六条语义） ──────────────────────────────── */

function isFinished(rec) {
  return !!rec && (rec.status === 'done' || rec.status === 'skipped');
}

function allStepsFinished(state, registry) {
  return registry.every((s) => isFinished(state.steps[s.id]));
}

// 语义 4：skipSteps 逃生舱——只对「未完成」step 标 skipped(reason: "user-ack")，
// done/skipped 不动；skipped 必带 reason 并透传终态 scriptResult.skippedSteps。
// skipSteps 消费本次发起参数（resume 时用户显式传入即为接管意图），
// state.params 保留首次发起的参数语境不回写。
function applySkipSteps(io, state, registry, stateFile, activeParams) {
  const skip = new Set((activeParams && activeParams.skipSteps) || []);
  if (skip.size === 0) return false;
  let changed = false;
  for (const step of registry) {
    const rec = state.steps[step.id];
    if (skip.has(step.id) && !isFinished(rec)) {
      state.steps[step.id] = {
        ...(rec || {}),
        status: 'skipped',
        reason: 'user-ack',
        finishedAt: io.now().toISOString(),
      };
      changed = true;
    }
  }
  if (changed) saveState(io, state, stateFile);
  return changed;
}

async function walkAndFinish(io, state, stateDir, activeParams) {
  const registry = io.steps || [];
  const stateFile = path.join(stateDir, state.runId, 'state.json');
  const runIdDir = path.join(stateDir, state.runId);

  applySkipSteps(io, state, registry, stateFile, activeParams);

  for (const step of registry) {
    const rec = state.steps[step.id];
    if (isFinished(rec)) continue; // 语义 2：done/skipped 一律不重跑

    // 语义 3：failed/in_progress（上次死在中途）整体重跑该 step
    state.steps[step.id] = {
      ...(rec || {}),
      status: 'in_progress',
      startedAt: io.now().toISOString(),
      attempts: ((rec && rec.attempts) || 0) + 1,
    };
    saveState(io, state, stateFile);

    const ctx = {
      state,
      params: state.params,
      runIdDir,
      io,
      saveCheckpoint() {
        saveState(io, state, stateFile); // gate 修复子循环每轮落盘的出口
      },
    };

    try {
      const runRes = (await step.run(ctx)) || {};
      if (runRes.skipped) {
        // 条件 step run 内判定不满足：落 skipped + reason（resume 只读落盘结果）
        state.steps[step.id] = {
          ...state.steps[step.id],
          status: 'skipped',
          reason: runRes.reason || 'unspecified',
          finishedAt: io.now().toISOString(),
        };
        saveState(io, state, stateFile);
        continue;
      }
      state.steps[step.id] = {
        ...state.steps[step.id],
        status: 'done',
        finishedAt: io.now().toISOString(),
        outputs: runRes,
      };
      saveState(io, state, stateFile);
    } catch (e) {
      const message = (e && e.message) ? e.message : String(e);
      state.steps[step.id] = {
        ...state.steps[step.id],
        status: 'failed',
        finishedAt: io.now().toISOString(),
        error: message,
      };
      saveState(io, state, stateFile);
      state.status = 'failed';
      state.failedStep = step.id;
      state.error = message;
      state.result = buildFailedResult(io, state, step.id, message);
      saveState(io, state, stateFile);
      return state.result;
    }
  }

  // 全部完成 → 唯一成功终态 awaiting-push。result 恒重建（不保留旧值）：
  // 旧 failed 快照若穿透（如上轮组装失败残留），CLI 终态会与 state.status 矛盾——
  // 组装的全部输入都在 state.steps 里，重建是幂等的（u4 冒烟实证）
  state.status = 'awaiting-push';
  state.failedStep = null;
  state.error = null;
  state.result = buildAwaitingPushResult(state);
  saveState(io, state, stateFile);
  return state.result;
}

/* ── repoRoot 解析（Gate B S1：workdir 是 RUN_ENVELOPE_KEYS 保留键不进 $ARGS，
   脚本读不到 workdir——仓库根必须显式经 --repo 传入，缺省回落宿主 cwd） ── */

/**
 * repoRoot 解析优先级：$ARGS.repo（发起方显式传）→ $WORKSPACE（宿主 cwd，引擎注入）
 * → path.resolve 兜底（进程 cwd）。返回绝对路径；是否为 git 仓库根由 runPipeline 开头的
 * 守卫校验（非根 fail-fast 带「--repo 传仓库根绝对路径」指引）。
 */
function resolveRepoRoot(args, workspace) {
  const a = args && typeof args.repo === 'string' && args.repo.trim() !== '' ? args.repo : null;
  const w = typeof workspace === 'string' && workspace.trim() !== '' ? workspace : null;
  return path.resolve(a || w || '.');
}

/* ── PR 阶段 steps（u2：§3.3 注册表前六项） ──────────────────────────── */

const MAX_GATE_ROUNDS = 3;

const PR_URL_RE = /^https:\/\/github\.com\/.+\/pull\/\d+$/;

// agent 纪律（§3.5）：全部经 ctx.io.agent（入口适配层已强制 returnMeta:true +
// error 观测）；schema 模式下 value 为校验后对象（引擎 parsedOutput），失败时
// value 回退为 content 字符串——结构校验兜底。
const CHANGESET_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['draft', 'no-release'] },
    files: { type: 'array', items: { type: 'string' }, description: '已写入的 .changeset/*.md 路径（action=draft 时必填）' },
    skipReasons: { type: 'array', items: { type: 'string' }, description: '逐包跳过原因（action=no-release 时必填）' },
  },
  required: ['action'],
};

const PR_META_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'PR title，conventional commit 风格，英文' },
    body: { type: 'string', description: 'PR body 全文 markdown，英文' },
  },
  required: ['title', 'body'],
};

/**
 * gate 修复子循环统一骨架（§3.5 / D8）：runGate 至多 MAX_GATE_ROUNDS 次；
 * 失败轮派 fix agent（修完自行 commit）；agent 返回后 porcelain 非空即 step
 * failed（第 1 次止损，不烧后续轮次 token——脚本不自动 commit，不判断改动归属）。
 * exit 2 = 工具错误，不自动重试。
 */
async function gateFixLoop(ctx, { stepId, gateName, runGate, onPass, extraFixContext }) {
  let lastRes = null;
  for (let round = 1; round <= MAX_GATE_ROUNDS; round++) {
    ctx.saveCheckpoint(); // 子循环每轮落盘
    lastRes = runGate();
    if (lastRes.code === 0) return onPass(lastRes);
    if (lastRes.code === 2) throw new Error(MSG.gateToolError(gateName, `${lastRes.stderr || ''}\n${lastRes.stdout || ''}`));
    if (round === MAX_GATE_ROUNDS) break;
    const fixed = await ctx.io.agent({
      description: `fix-${stepId}`,
      prompt: gateFixPrompt(stepId, round, lastRes)
        + (extraFixContext ? `\n\n${typeof extraFixContext === 'function' ? extraFixContext(round, lastRes) : extraFixContext}` : ''),
    });
    if (fixed.error) throw new Error(MSG.agentFailed(`gate 修复 agent（${stepId} round ${round}）`, fixed.error));
    const st = ctx.io.sh('git', ['status', '--porcelain']);
    if (st.code !== 0) throw new Error(MSG.gitFailed(['status', '--porcelain'], st.stderr));
    const dirt = worktreeDirt(st.stdout);
    if (dirt !== '') throw new Error(MSG.gateFixLeftDirty(dirt));
  }
  throw new Error(MSG.gateExhausted(gateName, MAX_GATE_ROUNDS, `${lastRes.stderr || ''}\n${lastRes.stdout || ''}`));
}

function changesetAgentPrompt(baseHash, diffStatOut, commitsOut, changesetFiles) {
  return [
    '任务：为分支改动补齐 changeset（对齐 Gate-1a.5 自动分类，不弹窗询问）。',
    '',
    '背景：检测到部分 extension 包改了 src/ 但没有对应 changeset（WARN changeset-check）。',
    '请按 diff 逐包分类并处理：',
    '- 实质行为改动（逻辑/接口/行为变化）→ 直接写入 .changeset/<slug>.md：',
    '  - frontmatter 声明受影响包，如：',
    '    ---',
    "    '@zhushanwen/pi-xxx': minor",
    '    ---',
    '  - type 初判按分支 conventional commits：feat→minor / fix→patch / BREAKING→major（type 终判 merge 阶段人工定）',
    '  - body 英文写用户可感变化（将进 CHANGELOG）',
    '- 非发布改动（纯注释/类型注解/测试/零行为差重构）→ 不写文件，记入 skipReasons（格式「包名: 原因 + 证据」）',
    '- 已删除的包跳过（package.json 读不到）',
    '',
    `diff --stat（base=${baseHash}..HEAD）：`,
    tailLines(diffStatOut, 120),
    '',
    'commits：',
    tailLines(commitsOut, 120),
    '',
    changesetFiles && changesetFiles.length
      ? `现有 changeset 文件（勿重复声明）：\n${changesetFiles.join('\n')}`
      : '现有 changeset 文件：无',
    '',
    '完成后以 action=draft + files（写入的文件路径列表）或 action=no-release + skipReasons 返回。',
  ].filter(Boolean).join('\n');
}

function prMetaAgentPrompt(baseHash, commitsOut, diffStatOut, changesetFiles) {
  return [
    '任务：从分支全部 commit 自动生成 PR title 与 body（英文，无需用户提供）。',
    '',
    'title 规则：conventional commit 风格（fix(scope): short summary；多 scope 取最核心的，或省略 scope）。',
    'body 规则（三节模板）：',
    '- ## Summary：改动目的',
    '- ## Changes：逐条列各 commit 关键改动，合并相关条目；有 changeset 文件一并展示',
    '- ## Test plan：typecheck/test/lint 结果说明',
    '- breaking changes 必须标明',
    '',
    `commits（git log ${baseHash}..HEAD --format="%s%n%b---"）：`,
    tailLines(commitsOut, 200),
    '',
    `diff --stat：`,
    tailLines(diffStatOut, 120),
    '',
    changesetFiles && changesetFiles.length
      ? `changeset 文件（在 Changes 节展示）：\n${changesetFiles.join('\n')}`
      : 'changeset 文件：无',
    '',
    '以 {title, body} 返回（body 为完整 markdown 全文）。',
  ].filter(Boolean).join('\n');
}

/**
 * PR 阶段六 steps 工厂（§3.3 注册表 preflight → pr-submit）。
 * scriptPaths 可注入（测试用假脚本路径；缺省从 repoRoot 按仓内真实布局推导）。
 */
/* ── 门禁 steps 辅助（u3：coverage/metrics 产物解析 + real-pi 同源预检） ── */

// pi-fixture.ts 同源常量（packages/runtime/src/__tests__/equivalence/pi-fixture.ts；
// 漂移防护：该文件变更 DEFAULT_MODEL 或探测链时须核对本节）
const REAL_PI_DEFAULT_MODEL = 'xiaomi-token-plan-cn/mimo-v2.5-pro';

// final-gates ③ 的 test:runtime 输出中 real-pi skip 的特征标记：
// ① pi-fixture 模块加载 console.warn：`[equivalence] 真实 pi（LLM turn）用例 skip：<理由>`
// ② 引用方 describe 名注入：`<suite>（skip：<REAL_PI_SKIP_REASON>）`，理由三种前缀
const REAL_PI_SKIP_MARKERS = [
  '[equivalence] 真实 pi（LLM turn）用例 skip：',
  '（skip：pi binary not found',
  '（skip：pi 凭证不可用',
  '（skip：env XYZ_SKIP_REAL_PI',
];

function coverageInsufficientReasonPrefix() {
  return '增量覆盖率'; // coverage-gate.py FAIL 条目 reason 固定前缀（覆盖率不足 vs 测试跑红的分流依据）
}

function readJsonFileQuiet(io, p) {
  try {
    return JSON.parse(io.fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readCoverageJson(io) {
  return readJsonFileQuiet(io, path.join(io.repoRoot, '.review', 'coverage.json'));
}

function readMetricsJson(io) {
  return readJsonFileQuiet(io, path.join(io.repoRoot, '.review', 'metrics.json'));
}

function stdoutVerdict(stdout, gateTag) {
  const m = String(stdout || '').match(new RegExp(`${gateTag} verdict=(\\w+)`));
  return m ? m[1] : null;
}

/**
 * coverage-gate.py exit 1 的两种 verdict 分流（注入值与 fixPrompt 的依据）：
 * - 'insufficient'：存在 FAIL 条目 reason 以「增量覆盖率」开头（测试全绿、覆盖不足）
 * - 'test-failure'：存在 FAIL 条目但非该前缀（vitest 实跑失败）；
 *   coverage.json 不可读时 fail-closed 归为 test-failure
 */
function classifyCoverageExit1(coverageJson) {
  if (!coverageJson || !coverageJson.packages) return 'test-failure';
  for (const pkg of Object.keys(coverageJson.packages)) {
    const e = coverageJson.packages[pkg];
    if (e && e.status === 'FAIL') {
      if (typeof e.reason === 'string' && e.reason.startsWith(coverageInsufficientReasonPrefix())) {
        return 'insufficient';
      }
      return 'test-failure';
    }
  }
  return 'test-failure';
}

// 注入值 = coverage-gate 的「测试判定」：pass 或 insufficient（测试全绿）→ PASS；
// test-failure → FAIL（§3.3 final-gates：--test-result 注入契约）
function coverageTestInject(exitCode, coverageJson) {
  if (exitCode === 0) return 'PASS';
  return classifyCoverageExit1(coverageJson) === 'insufficient' ? 'PASS' : 'FAIL';
}

// 增量覆盖率展示值：OK 包按可执行新增行加权汇总（coverage-gate 无聚合字段，此处从
// packages[] 汇总；无 OK 数据返回 null）
function coveragePctOf(coverageJson) {
  if (!coverageJson || !coverageJson.packages) return null;
  let covered = 0;
  let total = 0;
  for (const pkg of Object.keys(coverageJson.packages)) {
    const e = coverageJson.packages[pkg];
    if (e && e.status === 'OK') {
      covered += e.covered_executable_added_lines || 0;
      total += e.executable_added_lines || 0;
    }
  }
  if (total === 0) return null;
  return Math.round((covered / total) * 1000) / 10;
}

function coverageFixContext(io) {
  const cov = readCoverageJson(io);
  if (!cov) return 'coverage.json 不可读：以失败输出定位失败包。';
  const lines = [];
  for (const pkg of Object.keys(cov.packages || {})) {
    const e = cov.packages[pkg];
    if (e && e.status === 'FAIL') {
      lines.push(`- ${pkg}: ${e.reason || 'FAIL'}`);
      if (Array.isArray(e.uncovered_files) && e.uncovered_files.length > 0) {
        lines.push(`  未覆盖文件（定点补测试）：\n    ${e.uncovered_files.join('\n    ')}`);
      }
      if (Array.isArray(e.files_without_lcov) && e.files_without_lcov.length > 0) {
        lines.push(`  无 lcov 记录（未被任何测试加载或无可执行行）：\n    ${e.files_without_lcov.join('\n    ')}`);
      }
    }
  }
  if (lines.length === 0) return 'coverage.json 无 FAIL 包明细：以失败输出定位。';
  return [
    `coverage.json 失败明细（${path.join(io.repoRoot, '.review', 'coverage.json')}）：`,
    ...lines,
    '要求：为未覆盖文件补单元测试（测试放对应包的测试目录），或修复失败测试；不修改产品逻辑凑覆盖率、不放松阈值。',
  ].join('\n');
}

function metricsFixContext(io) {
  const m = readMetricsJson(io);
  const fails = (m && Array.isArray(m.fail)) ? m.fail : [];
  if (fails.length === 0) return 'metrics.json 不可读或无 fail 明细：以失败输出定位。';
  return [
    `metrics.json fail 明细（${path.join(io.repoRoot, '.review', 'metrics.json')}，前 10 条）：`,
    ...fails.slice(0, 10).map((f) => `- [${f.type}] ${f.path || (f.files || []).join(',')} ${f.name || ''} — ${f.reason || ''}`),
    '要求：按明细修复（降复杂度/解除循环依赖/清理 unresolved import）；不放松 .fallowrc.json 阈值。',
  ].join('\n');
}

/**
 * real-pi 凭证预检（final-gates ③ 执行前的 [MANDATORY] 门禁）。
 * 探测链与 packages/runtime/src/__tests__/equivalence/pi-fixture.ts 的
 * detectRealPiSkipReason() 同源：binary → env 强制态 → 凭证三源（env API key /
 * auth.json provider 条目 key / models.json providers[].apiKey）。
 * @returns null = 就绪；string = 缺失理由（进 failed 文案）
 */
function realPiPreflight(io) {
  const which = io.sh('which', ['pi']);
  if (which.code !== 0 || !which.stdout.trim()) {
    return 'pi binary not found（which pi 未命中）';
  }
  const forced = io.env ? io.env.XYZ_SKIP_REAL_PI : undefined;
  if (forced === '1' || forced === 'true') {
    return `env XYZ_SKIP_REAL_PI=${forced}（等价性基线双轨强制跳过态，门禁不接受）`;
  }
  const provider = REAL_PI_DEFAULT_MODEL.split('/')[0];
  const envKey = `${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`;
  const envValue = io.env ? io.env[envKey] : undefined;
  if (typeof envValue === 'string' && envValue.trim() !== '') return null;
  const envDir = io.env ? io.env.PI_CODING_AGENT_DIR : undefined;
  const agentDir = (envDir && envDir.trim() !== '') ? envDir : path.join(io.homedir(), '.pi', 'agent');
  const auth = readJsonFileQuiet(io, path.join(agentDir, 'auth.json'));
  if (auth && typeof auth === 'object') {
    const cred = auth[provider];
    if (cred && typeof cred === 'object' && typeof cred.key === 'string' && cred.key.trim() !== '') return null;
  }
  const models = readJsonFileQuiet(io, path.join(agentDir, 'models.json'));
  if (models && typeof models === 'object' && models.providers && typeof models.providers === 'object') {
    const entry = models.providers[provider];
    if (entry && typeof entry.apiKey === 'string' && entry.apiKey.trim() !== '') return null;
  }
  return `pi 凭证不可用：DEFAULT_MODEL "${REAL_PI_DEFAULT_MODEL}" 需要 provider "${provider}" 的 API key，env ${envKey} / auth.json / models.json 三源均未命中`;
}

/* ── cr-fix step 辅助（u4：§3.6 D2 嵌套内置 loop；§3.4-(3)-5 恢复粒度 = step 整体重跑） ── */

// terminated 全集（review-fix-loop.js 实测赋值，八种；未知值 fail-closed 按 failed）
const CR_FIX_PASS_TERMINATED = new Set(['clean', 'converged']);
const CR_FIX_RETRY_TERMINATED = new Set(['review-failure', 'aggregator-failure', 'fix-failure']);
const CR_FIX_STUCK_TERMINATED = new Set(['stuck', 'max-rounds', 'needs-redesign']);
const CR_FIX_MAX_NESTED_ATTEMPTS = 2; // 首次 + 自动重试恰 1 次（D2）

// batch1 组装（§3.5）：扫 <repoRoot>/.agents/skills/pr-cr-fix/agents/review-*.md 排序；
// reviewers 显式传入时做白名单交集（路径 substring 匹配任一关键词，不语义判断——
// SKILL 路径匹配排除表归主 agent 发起时自行决定）
function buildBatch1(io, agentsDir, reviewers) {
  let files = [];
  try {
    files = (io.fs.readdirSync(agentsDir) || [])
      .filter((f) => /^review-.*\.md$/.test(f))
      .sort()
      .map((f) => path.join(agentsDir, f));
  } catch {
    files = [];
  }
  if (Array.isArray(reviewers) && reviewers.length > 0) {
    files = files.filter((f) => reviewers.some((kw) => String(kw) !== '' && f.includes(String(kw))));
  }
  return files;
}

// runDir 下定位 aggregated.md（真实布局：runDir/batch-N/round-M/aggregated.md，
// all-clean 轮可能无任何报告）。浅扫描两层取排序最后一个（= 最大 batch/round）；
// 找不到返回 null（文案降级为 runDir）。
function findAggregatedFile(io, runDir) {
  if (!runDir) return null;
  const top = (() => {
    try { return io.fs.readdirSync(runDir) || []; } catch { return null; }
  })();
  if (!top) return null;
  if (top.includes('aggregated.md')) return path.join(runDir, 'aggregated.md');
  // 收集 (batch-N, round-M) 命中，按数值降序取最大（字典序会把 round-10 排在 round-2 前）
  const hits = [];
  for (const d1 of top.filter((n) => /^batch-\d+$/.test(n))) {
    const b = Number(d1.slice('batch-'.length));
    let level2 = [];
    try { level2 = io.fs.readdirSync(path.join(runDir, d1)) || []; } catch { continue; }
    for (const d2 of level2.filter((n) => /^round-\d+$/.test(n))) {
      let level3 = [];
      try { level3 = io.fs.readdirSync(path.join(runDir, d1, d2)) || []; } catch { continue; }
      if (level3.includes('aggregated.md')) {
        hits.push({ b, r: Number(d2.slice('round-'.length)), p: path.join(runDir, d1, d2, 'aggregated.md') });
      }
    }
    if (level2.includes('aggregated.md')) {
      hits.push({ b, r: -1, p: path.join(runDir, d1, 'aggregated.md') }); // batch 级直接报告视为该 batch 最前
    }
  }
  if (hits.length === 0) return null;
  hits.sort((x, y) => (y.b - x.b) || (y.r - x.r));
  return hits[0].p;
}

// nested 返回消费（§3.5 agent 纪律对 workflow 的映射）：parsedOutput 优先，
// 缺省解析 content JSON 兜底；nestedRunId = runDir basename（嵌套 run 独立 id）
function consumeNestedResult(io, res) {
  let parsed = res && typeof res.parsedOutput === 'object' && res.parsedOutput !== null ? res.parsedOutput : null;
  if (!parsed && typeof (res && res.content) === 'string') {
    try { parsed = JSON.parse(res.content); } catch { parsed = null; }
  }
  const terminated = parsed && typeof parsed.terminated === 'string' ? parsed.terminated : null;
  const runDir = parsed && typeof parsed.runDir === 'string' && parsed.runDir.trim() !== '' ? parsed.runDir : null;
  return {
    terminated,
    runDir,
    nestedRunId: runDir ? path.basename(runDir) : null,
    aggregatedFile: findAggregatedFile(io, runDir),
    message: parsed && typeof parsed.message === 'string' ? parsed.message : null,
  };
}

/* ── simplify step 辅助（u5：§3.6 D6 覆盖声明 / report 模式；§3.5 agent 纪律） ── */

const SIMPLIFY_SCHEMA = {
  type: 'object',
  properties: {
    applied: { type: 'integer', description: '已应用（A 档落地并 commit）的简化项数；report 模式恒 0' },
    proposals: { type: 'integer', description: '仅进报告未落地的提案数（B 档/低置信/无测量手段）' },
  },
  required: ['applied', 'proposals'],
};

// 契约全文内嵌（agent 纪律：必读 simplify-apply.md 原文全文进 prompt，不靠 agent 自行 read）
function simplifyPrompt(mode, contractText, baseHash, reportPath) {
  const modeHeader = mode === 'apply'
    ? [
        '【覆盖声明——本 task 的最高裁决条款】',
        '本 agent 由 pr-lifecycle workflow 以 simplifyMode=apply 发起，code-simplify skill 的「先报告、用户确认后改」确认断点在本上下文视为已获用户授权，授权范围仅 A 档（行为不变）高置信项；B 档（行为敏感）与低置信项只产报告不落地。',
        '',
      ]
    : [
        '【模式声明】',
        '本 run 以 simplifyMode=report 发起，code-simplify 的确认断点完整保留：只产报告，不改任何代码、不 commit。下方契约中「覆盖声明」与本模式冲突，以本声明为准。',
        '',
      ];
  return [
    ...modeHeader,
    '【固化契约（simplify-apply.md 原文全文——铁律 / 范围收敛 / A-B 档 / 报告格式 / 审查信号锚点均在此）】',
    contractText,
    '',
    '【本次执行上下文】',
    `baseHash = ${baseHash}`,
    `范围命令（写死）：git diff ${baseHash}...HEAD（--name-only 取文件清单）`,
    `报告输出路径 = ${reportPath}`,
    mode === 'apply'
      ? [
          '',
          '【apply 模式执行要求】',
          '1. 一次只做一个简化；每项改动后跑相关测试（无对应测试时跑该包 typecheck），失败即回滚这一步。',
          '2. 仅 A 档高置信项落地；B 档/低置信/无测量手段的性能候选只写报告。',
          '3. 全部完成后独立 commit：git add <显式路径列表> && git commit -m "refactor: code-simplify — N 项"（N = 已应用数）。禁止 git add -A / git add .。',
          '4. 报告写到「报告输出路径」（已应用 / 仅报告两区，按契约的报告格式）。',
          '5. 返回 JSON {"applied": N, "proposals": M}（report 模式 applied 恒 0）。不设墙钟超时：写操作不被中断，做完为止。',
        ].join('\n')
      : [
          '',
          '【report 模式执行要求】',
          '1. 只扫描与写报告，不改代码、不 commit、不写 reportPath 以外的文件。',
          '2. 报告按契约的报告格式：全部发现为提案，含 A/B 档标注与置信度。',
          '3. 返回 JSON {"applied": 0, "proposals": M}。',
        ].join('\n'),
  ].join('\n');
}

function createPrSteps({ repoRoot, scriptPaths = {} } = {}) {
  const paths = {
    preMerge: scriptPaths.preMerge || path.join(repoRoot, 'scripts', 'pr-pre-merge.sh'),
    prSubmit: scriptPaths.prSubmit || path.join(repoRoot, 'scripts', 'pr-submit.sh'),
    validateSkillYaml: scriptPaths.validateSkillYaml
      || path.join(repoRoot, '.agents', 'skills', 'pr-cr-fix', 'scripts', 'validate-skill-yaml.py'),
    selectConstraints: scriptPaths.selectConstraints || path.join(repoRoot, 'scripts', 'select-constraints.mjs'),
    coverageGate: scriptPaths.coverageGate
      || path.join(repoRoot, '.agents', 'skills', 'pr-cr-fix', 'scripts', 'coverage-gate.py'),
    metricsGate: scriptPaths.metricsGate
      || path.join(repoRoot, '.agents', 'skills', 'pr-cr-fix', 'scripts', 'metrics-gate.py'),
  };

  return [
    {
      id: 'preflight',
      run: async (ctx) => {
        const failures = [];
        const repo = ctx.io.sh('git', ['rev-parse', '--show-toplevel']);
        if (repo.code !== 0) failures.push(MSG.gitFailed(['rev-parse', '--show-toplevel'], repo.stderr));
        const st = ctx.io.sh('git', ['status', '--porcelain']);
        if (st.code !== 0) failures.push(MSG.gitFailed(['status', '--porcelain'], st.stderr));
        else if (worktreeDirt(st.stdout) !== '') failures.push(MSG.dirtyWorktree(worktreeDirt(st.stdout)));
        // baseHash 口径锁定：fresh 创建时已锁（createState），此处只在缺失时补锁
        // （resume 重跑 preflight 不重算——防 base ref 漂移后 review 口径变化）
        let baseHash = ctx.state.baseHash;
        if (!baseHash) {
          baseHash = resolveBaseHash(ctx.io, ctx.state.base);
          ctx.state.baseHash = baseHash;
        }
        const commits = ctx.io.sh('git', ['log', `${baseHash}..HEAD`, '--oneline']);
        if (commits.code !== 0) failures.push(MSG.gitFailed(['log', `${baseHash}..HEAD`], commits.stderr));
        else if (!commits.stdout.trim()) failures.push(MSG.preflightNoCommits(ctx.state.base));
        const gh = ctx.io.sh('gh', ['auth', 'status']);
        if (gh.code !== 0) failures.push(MSG.preflightGhAuth(gh.stderr || gh.stdout));
        const fallow = ctx.io.sh('fallow', ['--version']);
        if (fallow.code !== 0) failures.push(MSG.preflightFallow(fallow.stderr || fallow.stdout));
        if (failures.length > 0) throw new Error(MSG.preflightSummary(failures));
        return { baseHash };
      },
    },
    {
      id: 'static-gate',
      run: (ctx) => gateFixLoop(ctx, {
        stepId: 'static-gate',
        gateName: 'pr-pre-merge.sh --skip-tests',
        runGate: () => ctx.io.sh('bash', [paths.preMerge, '--skip-tests', '--quiet']),
        onPass: (res) => {
          const changesetWarn = /WARN changeset-check/.test(res.stdout);
          if (!changesetWarn) {
            // 条件判定随前置 done 的同一 checkpoint 落盘（§3.4-(2)）：changeset 不触发 →
            // 预写 skipped，resume walker 只读落盘结果，永不重算条件
            ctx.state.steps['changeset'] = {
              ...(ctx.state.steps['changeset'] || {}),
              status: 'skipped',
              reason: 'changeset-check 无 WARN：无 extension src/ 发布级改动，条件不满足',
              finishedAt: ctx.io.now().toISOString(),
            };
          }
          return { result: 'PASS', changesetWarn };
        },
      }),
    },
    {
      id: 'changeset',
      run: async (ctx) => {
        const sgOutputs = stepOutputs(ctx.state, 'static-gate');
        if (!sgOutputs || typeof sgOutputs.changesetWarn !== 'boolean') {
          throw new Error(MSG.changesetMissingWarn());
        }
        if (sgOutputs.changesetWarn === false) {
          // 防御重放：正常路径 false 已由 static-gate 预写 skipped（本 run 不会被执行）；
          // 条目缺失只可能因 state 被手工篡改——按落盘条件补 skipped，绝不真跑 agent
          return { skipped: true, reason: 'static-gate changesetWarn=false（落盘条件重放），无发布改动需补 changeset' };
        }
        const diffStat = ctx.io.sh('git', ['diff', `${ctx.state.baseHash}..HEAD`, '--stat']);
        const commits = ctx.io.sh('git', ['log', `${ctx.state.baseHash}..HEAD`, '--format=%s%n%b---']);
        const names = ctx.io.sh('git', ['diff', `${ctx.state.baseHash}..HEAD`, '--name-only']);
        const changesetFiles = names.stdout.split('\n').map((s) => s.trim()).filter((f) => /^\.changeset\/.+\.md$/.test(f));
        const res = await ctx.io.agent({
          description: 'changeset-draft',
          schema: CHANGESET_SCHEMA,
          prompt: changesetAgentPrompt(ctx.state.baseHash, diffStat.stdout, commits.stdout, changesetFiles),
        });
        if (res.error) throw new Error(MSG.agentFailed('changeset agent', res.error));
        const v = res.value;
        if (!v || typeof v !== 'object' || (v.action !== 'draft' && v.action !== 'no-release')) {
          throw new Error(MSG.agentInvalidOutput('changeset agent', v));
        }
        const drafted = Array.isArray(v.files) ? v.files : [];
        return {
          drafted,
          note: v.action === 'no-release'
            ? `非发布改动，跳过起草：${(Array.isArray(v.skipReasons) && v.skipReasons.join('; ')) || '见 agent 报告'}`
            : `已起草 ${drafted.length} 个 changeset 文件（type 初判，merge 阶段人工终判）`,
        };
      },
    },
    {
      id: 'pr-meta',
      run: async (ctx) => {
        const commits = ctx.io.sh('git', ['log', `${ctx.state.baseHash}..HEAD`, '--format=%s%n%b---']);
        if (commits.code !== 0) throw new Error(MSG.gitFailed(['log', `${ctx.state.baseHash}..HEAD`], commits.stderr));
        const diffStat = ctx.io.sh('git', ['diff', `${ctx.state.baseHash}..HEAD`, '--stat']);
        const names = ctx.io.sh('git', ['diff', `${ctx.state.baseHash}..HEAD`, '--name-only']);
        const changesetFiles = names.stdout.split('\n').map((s) => s.trim()).filter((f) => /^\.changeset\/.+\.md$/.test(f));
        const res = await ctx.io.agent({
          description: 'pr-meta',
          schema: PR_META_SCHEMA,
          prompt: prMetaAgentPrompt(ctx.state.baseHash, commits.stdout, diffStat.stdout, changesetFiles),
        });
        if (res.error) throw new Error(MSG.agentFailed('pr-meta agent', res.error));
        const v = res.value;
        if (!v || typeof v !== 'object' || typeof v.title !== 'string' || typeof v.body !== 'string'
          || !v.title.trim() || !v.body.trim()) {
          throw new Error(MSG.agentInvalidOutput('pr-meta agent', v));
        }
        const titleFile = path.join(ctx.runIdDir, 'pr-title.txt');
        const bodyFile = path.join(ctx.runIdDir, 'pr-body.md');
        ctx.io.fs.writeFileSync(titleFile, v.title);
        ctx.io.fs.writeFileSync(bodyFile, v.body);
        return { title: v.title, bodyFile };
      },
    },
    {
      id: 'skill-yaml',
      run: async (ctx) => {
        const names = ctx.io.sh('git', ['diff', `${ctx.state.baseHash}..HEAD`, '--name-only']);
        if (names.code !== 0) throw new Error(MSG.gitFailed(['diff', '--name-only'], names.stderr));
        const skillFiles = names.stdout.split('\n').map((s) => s.trim()).filter((f) => f.startsWith('.agents/skills/'));
        if (skillFiles.length === 0) {
          return { skipped: true, reason: 'diff 未触及 .agents/skills/，条件不满足' };
        }
        // 校验对象 = 改动过的 skill 目录的 SKILL.md（validate-skill-yaml.py 只收 SKILL.md 文件参数）
        const skillMd = [...new Set(skillFiles.map((f) => {
          const rest = f.slice('.agents/skills/'.length);
          return `.agents/skills/${rest.split('/')[0]}/SKILL.md`;
        }))];
        const res = ctx.io.sh('python3', [paths.validateSkillYaml, ...skillMd]);
        if (res.code !== 0) {
          throw new Error(MSG.skillYamlFail(`${res.stdout || ''}\n${res.stderr || ''}`));
        }
        return { validated: skillMd };
      },
    },
    {
      id: 'pr-submit',
      run: async (ctx) => {
        const bodyFile = stepOutputs(ctx.state, 'pr-meta')?.bodyFile;
        if (!bodyFile) throw new Error(MSG.prSubmitPrereq());
        const titleFile = path.join(ctx.runIdDir, 'pr-title.txt');
        const res = ctx.io.sh('bash', [paths.prSubmit, '--title-file', titleFile, '--body-file', bodyFile, '--base', ctx.state.base]);
        if (res.code === 0) {
          const urls = res.stdout.split('\n').map((s) => s.trim()).filter((l) => PR_URL_RE.test(l));
          if (urls.length === 0) throw new Error(MSG.prSubmitUrlMissing(res.stdout));
          return { prUrl: urls[urls.length - 1] };
        }
        const detail = `${res.stderr || ''}\n${res.stdout || ''}`;
        if (res.code === 2) throw new Error(MSG.prSubmitExit2(detail));
        if (res.code === 3) throw new Error(MSG.prSubmitExit3(detail));
        if (res.code === 5) throw new Error(MSG.prSubmitExit5(detail));
        throw new Error(`pr-submit 失败（exit ${res.code}）：\n${tailLines(detail, 20)}`);
      },
    },

    /* ── u3：门禁 steps（§3.3：constraints → coverage-1 → metrics-1；顺序固定，
       metrics-1 消费 coverage.json 的 files 节，walker 注册表顺序即执行保证） ── */
    {
      id: 'constraints',
      run: async (ctx) => {
        const res = ctx.io.sh('node', [paths.selectConstraints, '--base', ctx.state.base]);
        if (res.code !== 0) {
          throw new Error(MSG.constraintsFail(`${res.stderr || ''}\n${res.stdout || ''}`));
        }
        const constraintsFile = path.join(ctx.io.repoRoot, '.review', 'constraints.md');
        if (!ctx.io.fs.existsSync(constraintsFile)) throw new Error(MSG.constraintsMissing(constraintsFile));
        return { constraintsFile };
      },
    },
    {
      id: 'coverage-1',
      run: (ctx) => {
        const names = ctx.io.sh('git', ['diff', `${ctx.state.baseHash}..HEAD`, '--name-only']);
        const args = [paths.coverageGate, '--base', ctx.state.base];
        // shared 包 src 改动 → 追加下游兜底包（coverage-gate D12：--extra-packages 追加器语义）
        if (/(?:^|\n)packages\/shared\/(?:.+\/*\/)?src\//.test(`\n${names.stdout}`)) {
          args.push('--extra-packages', 'packages/runtime,packages/renderer');
        }
        return gateFixLoop(ctx, {
          stepId: 'coverage-1',
          gateName: `coverage-gate.py --base ${ctx.state.base}`,
          runGate: () => ctx.io.sh('python3', args),
          onPass: (res) => {
            const cov = readCoverageJson(ctx.io);
            return {
              coverageVerdict: (cov && cov.verdict) || stdoutVerdict(res.stdout, 'Gate-1.6') || 'pass',
              coveragePct: coveragePctOf(cov),
            };
          },
          extraFixContext: () => coverageFixContext(ctx.io),
        });
      },
    },
    {
      id: 'metrics-1',
      run: (ctx) => gateFixLoop(ctx, {
        stepId: 'metrics-1',
        gateName: `metrics-gate.py --base ${ctx.state.base}`,
        runGate: () => ctx.io.sh('python3', [paths.metricsGate, '--base', ctx.state.base]),
        onPass: (res) => {
          const m = readMetricsJson(ctx.io);
          return {
            metricsVerdict: (m && m.verdict) || stdoutVerdict(res.stdout, 'Gate-1.5') || 'pass',
          };
        },
        extraFixContext: () => metricsFixContext(ctx.io),
      }),
    },
    {
      // u4：cr-fix（§3.3 + D2）。断点恢复语义：step 重跑 = loop 整体重跑
      // （§3.4-(3)-5：fix commit 已进 git 历史，重跑面向当前 diff，通常 1-2 轮收敛）
      id: 'cr-fix',
      run: async (ctx) => {
        const agentsDir = path.join(repoRoot, '.agents', 'skills', 'pr-cr-fix', 'agents');
        const batch1 = buildBatch1(ctx.io, agentsDir, ctx.params.reviewers);
        if (batch1.length === 0) throw new Error(MSG.crFixNoBatch1(agentsDir, ctx.params.reviewers));
        // 参数名/类型对齐 review-fix-loop.js @pi-meta parameters（D2：嵌套不 copy）。
        // aggregatorModel 仅在发起方显式传入时透传（聚合降档/升档场景）；不传 = loop
        // 跟随 run 模型——Gate B S1 实证：8 reviewer 用默认 run 模型全成功，而硬编码
        // zai-coding-cn 在 pi 侧不存在（model_not_available → aggregator-failure×2）
        const nestedArgs = {
          targetType: 'git-diff',
          target: ctx.state.base,
          batch1: batch1.join(','),
          maxRounds: ctx.params.maxRounds,
          autoCommit: true,
          skipCleanAgents: true,
        };
        if (ctx.params.aggregatorModel) nestedArgs.aggregatorModel = ctx.params.aggregatorModel;
        const nestedRunIds = [];
        let last = null;
        for (let attempt = 1; attempt <= CR_FIX_MAX_NESTED_ATTEMPTS; attempt++) {
          ctx.saveCheckpoint(); // 每次 nested 发起前落盘（含 nestedRunId 的进度可追溯）
          last = consumeNestedResult(ctx.io, await ctx.io.workflow('review-fix-loop', nestedArgs));
          nestedRunIds.push(last.nestedRunId);
          const reportRef = last.aggregatedFile || last.runDir || `（runDir 未知，terminated=${last.terminated}）`;
          if (last.terminated && CR_FIX_PASS_TERMINATED.has(last.terminated)) {
            return { nestedRunId: nestedRunIds, terminated: last.terminated, aggregatedFile: last.aggregatedFile };
          }
          if (last.terminated && CR_FIX_RETRY_TERMINATED.has(last.terminated)) {
            if (attempt < CR_FIX_MAX_NESTED_ATTEMPTS) {
              ctx.io.log(`[cr-fix] nested loop ${last.terminated}（第 ${attempt} 次发起），自动重试 1 次`);
              continue;
            }
            throw new Error(MSG.crFixRetryExhausted(last.terminated, CR_FIX_MAX_NESTED_ATTEMPTS));
          }
          if (last.terminated && CR_FIX_STUCK_TERMINATED.has(last.terminated)) {
            // stuck / max-rounds / needs-redesign：人工接管双分支（§3.7）
            throw new Error(MSG.crFixStuck(last.terminated, reportRef, last.message));
          }
          // terminated 缺失（解析失败）或未知值：引擎契约演进，fail-closed
          throw new Error(MSG.crFixUnknownTerminated(last.terminated, reportRef));
        }
        throw new Error(MSG.crFixRetryExhausted(last && last.terminated, CR_FIX_MAX_NESTED_ATTEMPTS)); // 防御：循环不可达出口
      },
    },
    {
      // u5：simplify（§3.3 + D6）。仅 cr-fix clean/converged 才执行（防御重放只读落盘
      // outputs，不重算 nested）；恢复语义 = step 整体重跑（agent 面对当前 diff 重新评估，
      // 已应用的简化不会再被报出）；apply 模式不设墙钟超时（写操作不被打断，对齐内置 loop）
      id: 'simplify',
      run: async (ctx) => {
        const crFixOut = stepOutputs(ctx.state, 'cr-fix');
        const terminated = crFixOut && crFixOut.terminated;
        if (!terminated || !CR_FIX_PASS_TERMINATED.has(terminated)) {
          // 条件不满足落 skipped+reason：resume 只读落盘结果，永不重算 nested（§3.4-(2)）
          return { skipped: true, reason: `cr-fix 未 clean/converged（${terminated || '未执行或被跳过'}），简化缺位（G4 仅在 review 收敛后执行）` };
        }
        const apply = ctx.params.simplifyMode !== 'report';
        const contractPath = path.join(repoRoot, '.agents', 'skills', 'pr-cr-fix', 'agents', 'simplify-apply.md');
        let contract;
        try {
          contract = ctx.io.fs.readFileSync(contractPath, 'utf8');
        } catch (e) {
          throw new Error(MSG.simplifyContractMissing(`${contractPath}（${(e && e.message) || e}）`));
        }
        const reportPath = path.join(ctx.runIdDir, 'simplify-report.md');
        const res = await ctx.io.agent({
          description: 'simplify-apply',
          schema: SIMPLIFY_SCHEMA,
          prompt: simplifyPrompt(apply ? 'apply' : 'report', contract, ctx.state.baseHash, reportPath), // mode 以字符串形态进 prompt 构造（函数内按 mode === 'apply' 分支）
          // 不传 timeoutMs：apply 模式含写操作与 commit，不被墙钟打断（对齐内置 loop 的 fix 实践）
        });
        if (res.error) throw new Error(MSG.agentFailed('simplify agent', res.error));
        const v = res.value;
        if (!v || typeof v !== 'object' || !Number.isInteger(v.applied) || v.applied < 0
          || !Number.isInteger(v.proposals) || v.proposals < 0) {
          throw new Error(MSG.agentInvalidOutput('simplify agent', v));
        }
        const applied = apply ? v.applied : 0;
        // 结构性验证 1：agent 返回后 porcelain 非空 = 半成品（声称应用未 commit）或违规动码
        const st = ctx.io.sh('git', ['status', '--porcelain']);
        if (st.code !== 0) throw new Error(MSG.gitFailed(['status', '--porcelain'], st.stderr));
        const dirt = worktreeDirt(st.stdout);
        if (dirt !== '') throw new Error(MSG.simplifyLeftDirty(dirt, applied));
        // 结构性验证 2：报告必须落盘（skippedSteps 披露与事后审阅的载体）
        if (!ctx.io.fs.existsSync(reportPath)) throw new Error(MSG.simplifyReportMissing(reportPath));
        return { applied, proposals: v.proposals, reportFile: reportPath };
      },
    },
    {
      id: 'final-gates',
      run: async (ctx) => {
        const sharedSrcArgs = () => {
          const names = ctx.io.sh('git', ['diff', `${ctx.state.baseHash}..HEAD`, '--name-only']);
          return /(?:^|\n)packages\/shared\/(?:.+\/*\/)?src\//.test(`\n${names.stdout}`)
            ? ['--extra-packages', 'packages/runtime,packages/renderer']
            : [];
        };
        const outputs = await gateFixLoop(ctx, {
          stepId: 'final-gates',
          gateName: 'final-gates（coverage → metrics → pr-pre-merge --test-result，失败从 ① 头部重跑）',
          runGate: () => {
            // real-pi 双保险之一：③ 前同源预检（凭证缺失属环境前置，fail-fast 不进修复轮）
            const piMissing = realPiPreflight(ctx.io);
            if (piMissing) throw new Error(MSG.finalGatesRealPiMissing(piMissing));
            // ① coverage-gate（测试判定来源）
            const cov = ctx.io.sh('python3', [paths.coverageGate, '--base', ctx.state.base, ...sharedSrcArgs()]);
            if (cov.code !== 0) {
              return { code: cov.code, stdout: cov.stdout || '', stderr: cov.stderr || '', coverageJson: readCoverageJson(ctx.io) };
            }
            // ② metrics-gate
            const met = ctx.io.sh('python3', [paths.metricsGate, '--base', ctx.state.base]);
            if (met.code !== 0) {
              return { code: met.code, stdout: `${cov.stdout}\n${met.stdout}`, stderr: met.stderr || '' };
            }
            // ③ pr-pre-merge --test-result <注入值 = ① 的测试判定> --base <base ref 名>
            // （--base 与 ① coverage-gate 同值：脚本对 coverage.json 的 base 做 ref 名文本比对，
            // 传 baseHash 会比对失败；Gate B S1：stacked PR base≠main 必须显式传）
            const inject = coverageTestInject(cov.code, readCoverageJson(ctx.io));
            const pre = ctx.io.sh('bash', [paths.preMerge, '--test-result', inject, '--base', ctx.state.base]);
            return {
              code: pre.code,
              stdout: `${cov.stdout}\n${met.stdout}\n${pre.stdout}`,
              stderr: `${cov.stderr || ''}\n${met.stderr || ''}\n${pre.stderr || ''}`,
              coverageJson: readCoverageJson(ctx.io),
              metricsJson: readMetricsJson(ctx.io),
              inject,
            };
          },
          onPass: (res) => {
            // real-pi 双保险之二：输出 skip 标记解析（检出即 failed，不得凭 skip 宣布 PASS）
            const markers = REAL_PI_SKIP_MARKERS.filter((m) => res.stdout.includes(m));
            if (markers.length > 0) throw new Error(MSG.finalGatesRealPiSkip(markers));
            const cov = res.coverageJson;
            const met = res.metricsJson;
            let premergeResult = 'PASS';
            const marker = readPremergeMarker(ctx.io, ctx.io.repoRoot);
            if (marker) premergeResult = marker;
            if (premergeResult !== 'PASS') throw new Error(`final-gates：pre-merge marker result=${premergeResult}（非 PASS）`);
            return {
              coverageVerdict: (cov && cov.verdict) || 'pass',
              coveragePct: coveragePctOf(cov),
              metricsVerdict: (met && met.verdict) || 'pass',
              premergeResult,
            };
          },
          extraFixContext: (round) => [
            coverageFixContext(ctx.io),
            `注：本 step 三动作（coverage → metrics → pre-merge --test-result）每轮从 ① 头部重跑；当前第 ${round} 轮。`,
          ].join('\n\n'),
        });
        // 收尾防线（§3.3）：step 完成前最后一次 porcelain（.review/ 自持目录除外）——
        // 防「修复改动未 commit → 读数假绿 → push 后修复静默丢失」
        const st = ctx.io.sh('git', ['status', '--porcelain']);
        if (st.code !== 0) throw new Error(MSG.gitFailed(['status', '--porcelain'], st.stderr));
        const dirt = worktreeDirt(st.stdout);
        if (dirt !== '') throw new Error(MSG.finalGatesDirtyTail(dirt));
        return outputs;
      },
    },
  ];
}



/* ── 主入口 ──────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<object>} 终态 scriptResult（纯 JSON，可 structured-clone）。
 * 成功：{status:'awaiting-push', ...}；失败：{status:'failed', failedStep/error/resumeCommand}。
 * 守卫 fail-fast 不改写 state（返回 guard 失败 result），step 失败落盘 status:'failed'。
 */
async function runPipeline(io) {
  const params = normalizeParams(io.args);
  const engineRunId = io.args && typeof io.args._runId === 'string' ? io.args._runId : null;
  const stateDir = path.join(io.repoRoot, '.review', 'pr-workflow');

  let lockPath = null;
  try {
    // repoRoot 守卫（Gate B S1，最前——先于锁/latest/state 任何落盘，含 stateDir 目录本身）：
    // repoRoot 必须是 git 仓库根本身——workdir 是引擎保留键不进 $ARGS，repoRoot 靠 --repo
    // 显式传或宿主 cwd 回落，指向错误目录时后续全部检查面向错误仓库（S1 现场：preflight 审了宿主仓）
    const topRes = io.sh('git', ['rev-parse', '--show-toplevel']);
    if (topRes.code !== 0) {
      throw new GuardError(MSG.repoRootInvalid(io.repoRoot, topRes.stderr), {
        runId: params.runId,
        resumeCommand: resumeCommand(io, io.repoRoot, params.runId),
      });
    }
    // realpath 归一后比较：git 恒返回真实路径（macOS /tmp → /private/tmp），
    // 发起方传 symlink 形态路径时 resolve 不解析 symlink 会误判「不是仓库根」
    const real = (p2) => {
      try { return io.fs.realpathSync(p2); } catch { return path.resolve(p2); }
    };
    const top = topRes.stdout.trim();
    if (real(top) !== real(io.repoRoot)) {
      throw new GuardError(MSG.repoRootNotToplevel(io.repoRoot, top), {
        runId: params.runId,
        resumeCommand: resumeCommand(io, top, params.runId),
      });
    }

    io.fs.mkdirSync(stateDir, { recursive: true });
    lockPath = acquireLock(io, stateDir, engineRunId);

    const result = params.runId
      ? await resumeFlow(io, params, engineRunId, stateDir)
      : await freshFlow(io, params, engineRunId, stateDir, lockPath);

    // 终态（awaiting-push / failed）删除锁（§3.4-(1)）
    releaseLock(io, lockPath);
    lockPath = null;
    return result;
  } catch (e) {
    if (e instanceof GuardError) {
      if (lockPath) {
        releaseLock(io, lockPath);
        lockPath = null;
      }
      return guardFailResult(io, e, params.runId, io.repoRoot);
    }
    throw e; // 未预期异常：原样上抛（worker 侧报 error）；锁由下方 finally 兜底删除（正常终态已在 try 内先删）
  } finally {
    if (lockPath) releaseLock(io, lockPath);
  }
}

/** fresh：创建 runId（第一动作）→ 落盘 latest + state → walker */
async function freshFlow(io, params, engineRunId, stateDir, lockPath) {
  guardFreshConcurrent(io, stateDir);

  const runId = makeRunId(io.now, io.randomToken);
  if (!isValidRunId(runId)) throw new GuardError(`生成的 runId 不合法（${runId}）；检查 now/randomToken 注入`);
  writeLatest(io, stateDir, runId); // 暴毙兜底通道先落（先于任何副作用）
  updateLockContent(io, lockPath, runId, engineRunId);

  const git = gitSnapshot(io);
  const baseHash = resolveBaseHash(io, params.base);
  const state = createState({
    runId,
    repo: git.repo,
    branch: git.branch,
    base: params.base,
    baseHash,
    pid: io.pid,
    engineRunId,
    params,
    head: git.head,
  });

  const stateFile = path.join(stateDir, runId, 'state.json');
  io.fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  io.log(`runId=${runId} resumeCommand=${resumeCommand(io, git.repo, runId)}`); // §3.4-(1) 通道 3：log 首行
  saveState(io, state, stateFile);

  return walkAndFinish(io, state, stateDir, params);
}

/** resume：六道守卫（§3.4-(4) 顺序）→ engineRunId 刷新 → walker */
async function resumeFlow(io, params, engineRunId, stateDir) {
  const runId = params.runId;
  const stateFile = path.join(stateDir, runId, 'state.json');

  // 守卫 1：state 存在性与版本（fail-fast，绝不悄悄新建）
  if (!io.fs.existsSync(stateFile)) {
    throw new GuardError(MSG.stateMissing(runId), {
      runId,
      resumeCommand: resumeCommand(io, io.repoRoot, null), // 从头跑 = 不带 runId
    });
  }
  let state;
  try {
    state = JSON.parse(io.fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {
    throw new GuardError(`${MSG.stateMissing(runId)}（state 解析失败：${(e && e.message) || e}）`, {
      runId,
      resumeCommand: resumeCommand(io, io.repoRoot, null),
    });
  }
  if (!state || typeof state !== 'object' || state.stateVersion !== STATE_VERSION) {
    throw new GuardError(MSG.stateMissing(runId), { runId, resumeCommand: resumeCommand(io, io.repoRoot, null) });
  }

  // 守卫 2：repo 一致
  const git = gitSnapshot(io);
  if (state.repo !== git.repo) {
    throw new GuardError(MSG.repoMismatch(state.repo, git.repo), { runId });
  }

  // 守卫 3：分支一致
  if (state.branch !== git.branch) {
    throw new GuardError(MSG.branchMismatch(runId, state.branch), { runId });
  }

  // 守卫 4：活性双通道（对上一次发起的 engineRunId/pid；fail-closed）
  assertNotActive(io, state.engineRunId, state.pid);

  const registry = io.steps || [];

  // 语义 6：空转防护（先于 HEAD 守卫——全 done 场景不适用外部变更守卫）
  if (allStepsFinished(state, registry)) {
    if (git.head === state.lastHead) {
      touchRunContext(io, state, engineRunId);
      // 回放前提：state 与 result 快照双双是 awaiting-push 终态（result.status 才是
      // 快照内容的权威——旧 failed 残留快照不得借 status 蒙混回放，u4 冒烟实证）
      if (state.status === 'awaiting-push' && state.result && state.result.status === 'awaiting-push') {
        saveState(io, state, stateFile); // 幂等回放：仅刷新 engineRunId/pid，result 原样
        io.log(`[resume] run ${runId} 已全部完成且 HEAD 未变，回放既有终态`);
        return state.result;
      }
      // 组装期中断残留：全 step done 但终态仍是 failed / 快照缺失——若照旧回放，
      // 旧 error 快照会被永续（恢复指引死循环）。从现存 steps outputs 重建 awaiting-push
      // 快照（error 清空）重写 state 后返回。
      state.status = 'awaiting-push';
      state.failedStep = null;
      state.error = null;
      state.result = buildAwaitingPushResult(state);
      saveState(io, state, stateFile);
      io.log(`[resume] run ${runId} 全部 step 完成但终态为 failed/快照缺失（组装期中断残留），已重建 result`);
      return state.result;
    }
    throw new GuardError(MSG.allDoneHeadMoved(runId, state.lastHead, git.head, resumeCommand(io, io.repoRoot, null)), {
      runId,
      resumeCommand: null, // 指向「起新 run」而非 resume，防指引链兜圈
    });
  }

  // 守卫 5：工作区干净（.review/ 为脚本自持目录，不计入脏）
  const st = io.sh('git', ['status', '--porcelain']);
  if (st.code !== 0) throw new GuardError(MSG.gitFailed(['status', '--porcelain'], st.stderr), { runId });
  const dirt = worktreeDirt(st.stdout);
  if (dirt !== '') {
    throw new GuardError(MSG.dirtyWorktree(dirt), { runId });
  }

  // 守卫 6：HEAD 外部变更（status=failed 时外部 commit 是预期恢复动作，直接放行）
  if (git.head !== state.lastHead && state.status !== 'failed') {
    if (!params.allowExternalChanges) {
      throw new GuardError(MSG.externalChanges(state.lastHead, git.head), { runId });
    }
    io.log(`[guard] HEAD 外部变更（${state.lastHead} → ${git.head}）已由 allowExternalChanges=true 显式放行`);
  }

  // 守卫全过 → 刷新本次发起的 engineRunId/pid（活性守卫主通道永远读最近一次 run）
  touchRunContext(io, state, engineRunId);

  return walkAndFinish(io, state, stateDir, params);
}

function touchRunContext(io, state, engineRunId) {
  state.engineRunId = engineRunId || state.engineRunId;
  state.pid = io.pid;
}

function updateLockContent(io, lockPath, runId, engineRunId) {
  writeLockContent(io, lockPath, runId, engineRunId);
}

module.exports = {
  STATE_VERSION,
  STATE_FIELDS,
  ENGINE_TERMINAL_STATUS,
  SH_MAX_BUFFER_BYTES,
  MAX_GATE_ROUNDS,
  PR_URL_RE,
  MSG,
  GuardError,
  normalizeParams,
  makeRunId,
  isValidRunId,
  createState,
  saveState,
  createSh,
  resumeCommand,
  resolveZswCli,
  readPremergeMarker,
  resolveRepoRoot,
  worktreeDirt,
  REAL_PI_DEFAULT_MODEL,
  REAL_PI_SKIP_MARKERS,
  CR_FIX_PASS_TERMINATED,
  CR_FIX_RETRY_TERMINATED,
  CR_FIX_STUCK_TERMINATED,
  CR_FIX_MAX_NESTED_ATTEMPTS,
  buildBatch1,
  findAggregatedFile,
  consumeNestedResult,
  classifyCoverageExit1,
  coverageTestInject,
  coveragePctOf,
  realPiPreflight,
  gateFixLoop,
  createPrSteps,
  runPipeline,
};
