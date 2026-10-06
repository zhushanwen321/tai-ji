/* @pi-meta
name: tech-review-loop
description: "tech-design-wf T2 审查循环：价值审先行 → 三 reviewer 并行 → 修复 → 聚焦复审，至 0 must-fix 收敛"
phases: ['value-review', 'review', 'fix', 'finalize']
parameters:
  type: object
  properties:
    designDoc:
      type: string
      description: "设计文档绝对路径"
    projectRoot:
      type: string
      description: "项目根绝对路径（缺省用 $WORKSPACE）"
    maxRounds:
      type: number
      description: "最大审查-修复轮数，缺省 10"
    attempt:
      type: number
      description: "重发起序号，>1 时轮次目录带 .attemptN 后缀防覆盖，缺省 1"
    model:
      type: string
      description: "审查/修复 agent 使用的模型 id（provider/model），缺省 zai-coding-cn/glm-5.3-flash"
  required: [designDoc]
usage: |
  ### 发起
  workflow run tech-review-loop --args designDoc=<绝对路径> projectRoot=<项目根> [maxRounds=10] [attempt=1]
  ### 终态
  converged / value-rejected / escalated / stuck / max-rounds / review-failure / fix-failure
  ### 产物
  `<projectRoot>/.tmp/tech-design/<name>/`：review-value.md、round-N[.attemptM]/{review-main,impact,simplicity}.md、problems.json、dispositions.{md,json}、final.json
*/

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// ── 入参 ─────────────────────────────────────────────
const designDoc = $ARGS.designDoc;
const projectRoot = $ARGS.projectRoot || $WORKSPACE;
const maxRounds = Number($ARGS.maxRounds || 10);
const attempt = Number($ARGS.attempt || 1);
const MODEL = $ARGS.model || 'zai-coding-cn/glm-5.3-flash';
if (!designDoc || !fs.existsSync(designDoc)) throw new Error(`designDoc 不存在：${designDoc}`);

// ── 路径约定（flow/review.md 产物路径）────────────────
const SKILL = path.join(os.homedir(), '.agents', 'skills', 'tech-design-wf');
const RUBRIC = path.join(SKILL, 'review', 'rubric-design-doc.md');
const CHECK = path.join(SKILL, 'scripts', 'check-dispositions.mjs');
const docName = path.basename(designDoc, '.md');
const runDir = path.join(projectRoot, '.tmp', 'tech-design', docName);
fs.mkdirSync(runDir, { recursive: true });
const attemptTag = attempt > 1 ? `.attempt${attempt}` : '';
const roundPath = (n) => path.join(runDir, `round-${n}${attemptTag}`);

// ── schema（结构化返回的字段名权威）──────────────────
const PROBLEM_ITEM = { type: 'object', properties: { ref: { type: 'string' }, level: { type: 'string', enum: ['must-fix', 'suggestion'] }, title: { type: 'string' } }, required: ['ref', 'level', 'title'] };
const REVIEW_SCHEMA = { type: 'object', properties: { reportFile: { type: 'string' }, mustFix: { type: 'number' }, suggestion: { type: 'number' }, problems: { type: 'array', items: PROBLEM_ITEM } }, required: ['reportFile', 'mustFix', 'suggestion', 'problems'] };
const VALUE_SCHEMA = { type: 'object', properties: { reportFile: { type: 'string' }, mustFix: { type: 'number' }, suggestion: { type: 'number' }, oneliner: { type: 'string' }, problems: { type: 'array', items: PROBLEM_ITEM } }, required: ['reportFile', 'mustFix', 'suggestion', 'oneliner', 'problems'] };
const FIX_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, revisionSummary: { type: 'string' }, attackerHints: { type: 'string' }, escalations: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, title: { type: 'string' }, reason: { type: 'string' } }, required: ['ref', 'title', 'reason'] } }, suggestionFixed: { type: 'number' }, suggestionDeferred: { type: 'number' }, suggestionArchived: { type: 'number' } }, required: ['ok', 'revisionSummary', 'escalations', 'suggestionFixed', 'suggestionDeferred', 'suggestionArchived'] };

const COMMON = `【通用上下文】设计文档：${designDoc}。判据：先 read ${RUBRIC} 加载。目标项目根：${projectRoot}——先 read 其 AGENTS.md（存在时）提取项目约定；声称源码事实前必须 read 源码核实，只报影响决策的事实错误（机械性细节不报）。全托管模式：禁止任何等待用户输入的操作；遇到决策点自行裁决并写入报告 INFO 节。只审查、只报告，不修改文档。`;

const countMustFix = (list) => list.filter((p) => p.level === 'must-fix').length;

function writeFinal(terminated, rounds, extra) {
  const final = {
    terminated,
    rounds,
    runDir,
    designDoc,
    oneliner: extra.oneliner || '',
    reportFile: extra.reportFile || '',
    mustFixTrajectory: extra.trajectory || [],
    suggestionDispositions: extra.sugg || null,
    remaining: extra.remaining || [],
    blocked: [],
    message: extra.message || '',
  };
  fs.writeFileSync(path.join(runDir, 'final.json'), JSON.stringify(final, null, 2));
  return final;
}

// ── 修复轮（审查与修复分离：修复者只修 reviewer 报告的问题）──
async function runFix(n, problems, rd, dispositionOnly) {
  phase('fix');
  const problemsJson = path.join(rd, 'problems.json');
  const dispMd = path.join(rd, 'dispositions.md');
  const dispJson = path.join(rd, 'dispositions.json');
  const mode = dispositionOnly
    ? '本轮 must-fix 已为 0：只对全部 suggestion 逐条三选一处置（fixed=修复进文档 / deferred=登记不修含一句话理由 / archived=归档到文档相应节的待办或残留风险），不新开修复面。'
    : '修复全部 must-fix——反例重演后再动笔（审查给的修复方向也要重演，不照单全收）；被击穿的方案连同反例写入该决策「不采用」栏；决策改动过联动同步清单五处（正文该决策 / 终态数据流图 / 错误规格表 / 拆分单元表+文件地图 / 验收节）；同类缺口全文扫同模式实例一并修。全部 suggestion 逐条三选一处置（fixed/deferred/archived，判定线见 Step 8.1）。影响决策=是的条目不自行改方案方向，列入 escalations 停回用户。';
  const prompt = `你是设计文档修复者（tech-design-wf 修复轮；审查与修复分离——你只修 reviewer 报告的问题）。先 read ${SKILL}/flow/write.md 的「Step 8」节（8.1 每轮修复规则 / 8.2 修复纪律）加载修复协议。
设计文档：${designDoc}（直接编辑此文件）。本轮问题清单：read ${problemsJson}。
${mode}
产出（缺一不可）：
1. 更新设计文档；
2. 处置表写到 ${dispMd}，每条含：id（D-${n}-<序>）/ source（来源 ref 数组，逐条引用 problems.json 的 ref）/ action（fixed|deferred|archived）/ 修订位置 / 反例重演（must-fix 必填）/ 攻击点建议 / 影响决策（是|否）/ 影响交付（环节|无）；
3. 同内容结构化写 ${dispJson}（格式 {"dispositions":[...]}，action 用英文枚举 fixed|deferred|archived，source 逐条引用 ref，必须覆盖 problems.json 全部 ref）；
4. 运行 node ${CHECK} ${dispJson} --problems ${problemsJson} 至退出码 0（失败按 stdout JSON 补正处置表重跑，最多 5 次）；
5. 追加一行运行记录到 ${runDir}/runlog-fixer.md（[HH:MM] 类型: 一句话事实）。
结构化返回（字段以 schema 为准）：revisionSummary=本轮修订摘要（给下轮聚焦复审注入）；attackerHints=给下轮 reviewer 的攻击点建议；escalations=影响决策=是的条目；suggestionFixed/suggestionDeferred/suggestionArchived=处置计数。`;
  let fix;
  try {
    fix = await agent({ prompt, schema: FIX_SCHEMA, description: 'apply-review-fixes', model: MODEL });
  } catch (e) {
    log(`fixer agent 失败（round ${n}）：${e}`);
    return { terminated: 'fix-failure', sugg: null, err: String(e) };
  }
  // 机器校验兜底（业务级约束：覆盖完整性 + 条目内部一致性）
  const runCheck = () => { execFileSync('node', [CHECK, dispJson, '--problems', problemsJson], { stdio: ['ignore', 'pipe', 'pipe'] }); };
  let checkOk = true;
  try {
    runCheck();
  } catch (e) {
    const report = ((e && e.stdout) || '').toString();
    log(`处置表校验失败（round ${n}），回喂补正：${report.slice(0, 500)}`);
    try {
      await agent({ prompt: `上次修复产出的处置表未过机器校验，请补正。处置表：${dispJson}（与 ${dispMd} 保持同步）。校验报告：${report || `自行运行 node ${CHECK} ${dispJson} --problems ${problemsJson} 查看`}。按报告逐条补正后重跑校验至退出码 0。只补正处置表与必要的文档同步，不新开修复面。结构化返回 ok=最终校验是否通过。`, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, description: 'repair-dispositions', model: MODEL });
      runCheck();
    } catch (e2) {
      checkOk = false;
      log(`处置表补正后仍未过校验（round ${n}）：${e2}`);
    }
  }
  if (!checkOk) return { terminated: 'fix-failure', sugg: null };
  const sugg = { fixed: fix.suggestionFixed, deferred: fix.suggestionDeferred, archived: fix.suggestionArchived };
  if (fix.escalations && fix.escalations.length > 0) {
    return { terminated: 'escalated', sugg, escalations: fix.escalations, revisionSummary: fix.revisionSummary, attackerHints: fix.attackerHints, dispMd };
  }
  return { sugg, revisionSummary: fix.revisionSummary, attackerHints: fix.attackerHints, dispMd, escalations: [] };
}

// ── Phase 1：价值审（循环外，一次）────────────────────
phase('value-review');
const value = await agent({
  prompt: `你是 tech-design-value-review。先 read ${SKILL}/agents/tech-design-value-review.md 加载完整身份与判据。${COMMON}
任务：对设计文档做价值评审（先于三 reviewer 的第一道门）：①一句话复述测试（复述本身是交付物；复述不出/很复杂/含行话 = 不通过）②问题值不值得这么解（现状保留行为逐个论证、伪需求识别、求解量级与破坏面匹配）③产品最小形态检查（三层显式作答）。只审方向与量级；机制正确性/影响面/过度设计留给三 reviewer，发现时标 INFO 交接。声称「现状行为与代码不符」前必须 read 源码核实。
报告写到 ${runDir}/review-value.md（含 Summary + 一句话复述 + Findings 表，每行带锚点编号 review-value#N）。
结构化返回（字段以 schema 为准）：problems 每条 {ref:"review-value#N", level, title}，条数合计须等于 mustFix+suggestion；oneliner=你的一句话复述。`,
  schema: VALUE_SCHEMA,
  description: 'value-review',
  model: MODEL,
});
const valueMustFix = countMustFix(value.problems || []);
if (valueMustFix > 0 || (value.mustFix || 0) > 0) {
  const final = writeFinal('value-rejected', 0, { oneliner: value.oneliner, reportFile: value.reportFile, message: `价值审 must-fix ${Math.max(valueMustFix, value.mustFix || 0)} 条——按其修复方向回 T1 重写问题定义/方案主干，修完重新发起（attempt+1）。报告：${value.reportFile}` });
  return { terminated: 'value-rejected', rounds: 0, runDir, valueReport: value.reportFile, oneliner: value.oneliner, final };
}

// ── Phase 2/3：审查-修复循环 ─────────────────────────
const dims = [
  ['main', 'tech-design-review', 'review-main.md'],
  ['impact', 'tech-design-impact-review', 'review-impact.md'],
  ['simplicity', 'tech-design-simplicity-review', 'review-simplicity.md'],
];
const trajectory = [];
let prev = null;
let round = 0;
let terminated = null;
let lastSugg = null;
let lastRoundDir = null;
let failErr = '';

const focusText = (n) => n === 1
  ? '本轮 R1 全面审：逐项对抗式审查（四大方向见你加载的模板），找反例和攻击点；重点审查验收章节（P0-13/14/15/21：真实场景而非单测/mock、投入匹配改动大小、每场景回溯目标、具体业务例子、外部共享系统表面不变场景）。'
  : `本轮 R2+ 聚焦复审——不做全面重扫，不重查已确认项，只审三件事：①上轮 must-fix 修复是否成立（fixed 须实证：读了什么、确认了什么；上轮处置表 read ${prev.dispMd}）②修复是否引入新问题（只扫修复触及的章节）③上轮 deferred/archived 登记不修项的上下文是否被改变（结构化申报复活）。\n【上轮修订摘要】${prev.revisionSummary}\n【修订方攻击点建议（优先攻击）】${prev.attackerHints || '（无）'}`;

while (true) {
  round++;
  if (round > maxRounds) { terminated = 'max-rounds'; break; }
  const rd = roundPath(round);
  fs.mkdirSync(rd, { recursive: true });
  lastRoundDir = rd;
  phase('review');
  let results;
  try {
    results = await parallel(dims.map(([dim, tpl, file]) => agent({
      prompt: `你是 ${tpl}。先 read ${SKILL}/agents/${tpl}.md 加载完整身份、分工与判据。${COMMON}
${focusText(round)}
报告写到 ${rd}/${file}，每条问题小节标题带锚点编号 review-${dim}#N。
结构化返回（字段以 schema 为准）：problems 每条 {ref:"review-${dim}#N", level, title}，条数合计须等于 mustFix+suggestion。`,
      schema: REVIEW_SCHEMA,
      description: `review-${dim}`,
      model: MODEL,
    })));
  } catch (e) {
    terminated = 'review-failure';
    failErr = String(e);
    break;
  }
  const problems = results.flatMap((r) => r.problems || []);
  const fromList = countMustFix(problems);
  const reported = results.reduce((s, r) => s + (r.mustFix || 0), 0);
  fs.writeFileSync(path.join(rd, 'problems.json'), JSON.stringify({ round, problems, reportedMustFix: reported }, null, 2));
  const mustFix = Math.max(fromList, reported);
  const suggestionN = problems.length - fromList;
  trajectory.push(mustFix);
  log(`round ${round}：must-fix=${mustFix}（清单 ${fromList}/自报 ${reported}）suggestion=${suggestionN}`);

  if (mustFix === 0) {
    if (suggestionN > 0) {
      const d = await runFix(round, problems, rd, true);
      lastSugg = d.sugg;
      if (d.terminated) { terminated = d.terminated; failErr = d.err || ''; break; }
    }
    terminated = 'converged';
    break;
  }
  // 停机线：连续 3 轮 must-fix 不降
  if (trajectory.length >= 3) {
    const t = trajectory.slice(-3);
    if (t[0] <= t[1] && t[1] <= t[2]) { terminated = 'stuck'; break; }
  }
  const d = await runFix(round, problems, rd, false);
  lastSugg = d.sugg;
  if (d.terminated) { terminated = d.terminated; failErr = d.err || ''; lastRoundDir = rd; break; }
  prev = d;
}

// ── 终态落盘 ─────────────────────────────────────────
phase('finalize');
let remaining = [];
try {
  const lastDisp = path.join(lastRoundDir || runDir, 'dispositions.json');
  if (fs.existsSync(lastDisp)) {
    const root = JSON.parse(fs.readFileSync(lastDisp, 'utf8'));
    const arr = Array.isArray(root) ? root : root.dispositions || [];
    remaining = arr.filter((x) => x.action !== 'fixed').map((x) => `${x.id}[${x.action}] ${x.source ? x.source.join(',') : ''}`);
  }
} catch (e) { log(`读取最终处置表失败：${e}`); }
const messages = {
  converged: `审查收敛：${round} 轮，must-fix 轨迹 [${trajectory.join(' → ')}]，suggestion 已全部处置（fixed ${lastSugg ? lastSugg.fixed : 0} / deferred ${lastSugg ? lastSugg.deferred : 0} / archived ${lastSugg ? lastSugg.archived : 0}）。`,
  escalated: `修复轮出现影响决策的方案性意见，停回用户裁决后改文档重新发起（attempt+1）。`,
  stuck: `连续 3 轮 must-fix 不降 [${trajectory.slice(-3).join(' → ')}]——呈报残余风险矩阵，用户裁决。`,
  'max-rounds': `达最大轮数 ${maxRounds}，must-fix 轨迹 [${trajectory.join(' → ')}]——呈报用户裁决（最后一轮修复已执行但未复审）。`,
  'review-failure': `reviewer agent 调用失败：${failErr}`,
  'fix-failure': `修复者或处置表机器校验失败：${failErr || '处置表未过 check-dispositions 校验'}`,
};
const final = writeFinal(terminated, round, {
  oneliner: value.oneliner,
  reportFile: lastRoundDir ? path.join(lastRoundDir, 'review-main.md') : value.reportFile,
  trajectory,
  sugg: lastSugg,
  remaining,
  message: messages[terminated] || terminated,
});
return { terminated, rounds: round, runDir, designDoc, oneliner: value.oneliner, mustFixTrajectory: trajectory, suggestionDispositions: lastSugg, remaining, message: final.message, final };