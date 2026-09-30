#!/usr/bin/env node
/**
 * mock pi 症状复现基线 runner（U0 验收条款②）——F1-F5 各产一条「实跑证据 + GUI 构造法 + 代码锚点」。
 *
 * 复现通道（零 token、确定性、约 15s）：
 * - mock pi 脚本族（../mock-pi/）扮演现版 pi-plan 扩展行为（cancelled 不落盘 / executeComplete
 *   先清 reviewState 再挂表单 / E3 steer 重挂前提）；
 * - derive-probe.mts 直接调用**现版生产派生函数**（runtime scanPlanStateEntries + renderer
 *   derivePlanStage）——复现判定零镜像面；
 * - 代码锚点 = 现版源文件行提取（症状机制的代码证据）。
 *
 * 层级声明：实跑覆盖协议层 / 持久层 / 派生层；GUI 层（审批条渲染态）复现需 dev 实例 +
 * CDP 交互，逐条给出构造法归 U6 验收窗执行（deviations 已登记）。
 *
 * 用法：
 *   node scripts/acceptance/plan-mode/repro/repro-baseline.mjs [--out .tmp/dev-flow/mock-pi-repro-baseline.md]
 * 退出码：0 = F1-F5 全部复现成功；1 = 任一复现失败（基线不可信，禁止交付）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..', '..');
const MOCK_PI = join(SCRIPT_DIR, '..', 'mock-pi', 'mock-pi.mjs');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const DERIVE_PROBE = join(SCRIPT_DIR, 'derive-probe.mts');

const outIdx = process.argv.indexOf('--out');
const outPath = outIdx >= 0 ? resolve(process.argv[outIdx + 1]) : null;

const work = mkdtempSync(join(tmpdir(), 'mock-pi-repro-'));
const sections = [];
const repros = [];

// ── 小型 mock harness（同 selftest 的通道，独立薄壳）──────────────────
function spawnMock(scenario, extra = {}) {
  const configPath = join(work, `cfg-${scenario}-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify({ scenario, ...extra }));
  const proc = spawn(process.execPath, [MOCK_PI, '--config', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  let waiters = [];
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let f;
      try { f = JSON.parse(line); } catch { continue; }
      frames.push(f);
      waiters = waiters.filter((w) => !w(f));
    }
  });
  const waitFor = (pred, timeoutMs = 5000, label = 'frame') => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), timeoutMs);
    const hit = frames.find(pred);
    if (hit) { clearTimeout(t); res(hit); return; }
    waiters.push((f) => { if (pred(f)) { clearTimeout(t); res(f); return true; } return false; });
  });
  const send = (o) => proc.stdin.write(`${JSON.stringify(o)}\n`);
  return { proc, frames, waitFor, send };
}

function deriveProbe(sessionFile) {
  const r = spawnSync(TSX, ['--tsconfig', join(REPO_ROOT, 'packages/renderer/tsconfig.json'), DERIVE_PROBE, sessionFile], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`derive-probe failed: ${r.stderr?.slice(0, 400)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

function readRepo(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8').split('\n');
}

function anchor(rel, regex, limit = 8) {
  const hits = readRepo(rel)
    .map((text, i) => ({ no: i + 1, text }))
    .filter((l) => regex.test(l.text))
    .slice(0, limit)
    .map((l) => `${rel}:${l.no}: ${l.text.trim().slice(0, 220)}`);
  return hits.length ? hits.join('\n') : `${rel}: <未命中 ${regex}>`;
}

function block(title, body) {
  return `\n### ${title}\n\n\`\`\`\n${body}\n\`\`\`\n`;
}

function record(id, ok, verdict) {
  repros.push({ id, ok, verdict });
  console.log(`${ok ? 'REPRODUCED' : 'MISSED'}  ${id}  —  ${verdict}`);
}

let head;
try {
  const gitHead = safe(() => execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim(), '<unknown>');
  const dirty = safe(() => execFileSync('git', ['-C', REPO_ROOT, 'status', '--short'], { encoding: 'utf-8' }).trim(), '');
  head = [
    '# mock pi 症状复现基线（F1-F5）',
    '',
    '> U0 验收条款②产物。复现通道 = mock pi 脚本族（`scripts/acceptance/plan-mode/mock-pi/`，模拟**现版** pi-plan 扩展行为）',
    '> + 真实派生探针 `repro/derive-probe.mts`（直接调用现版 `scanPlanStateEntries` / `derivePlanStage`，零镜像面）',
    '> + 现版源码行锚点。生成命令：`node scripts/acceptance/plan-mode/repro/repro-baseline.mjs --out .tmp/dev-flow/mock-pi-repro-baseline.md`。',
    '',
    `- 采集时间：${new Date().toISOString()}`,
    `- git HEAD：${gitHead}${dirty ? '（工作树含在途改动，见下）' : ''}`,
    dirty ? `- 工作树状态：\n\`\`\`\n${dirty}\n\`\`\`` : '- 工作树状态：clean',
    '',
    '## 复现层级声明',
    '',
    '每条复现 = **协议层 / 持久层 / 派生层实跑**（确定性、零 token）+ **GUI 层构造法**（审批条渲染态的真机复现步骤，归 U6 验收窗执行）。',
    'GUI 层不在此实跑的原因：需 dev 实例 + CDP 点击编排（跨窗口资产），且验收条款允许「能做到的实跑，做不到的写明构造法并计入 deviations」。',
  ].join('\n');

  // ═══ F1 忽略「没反应」：cancelled 分支不落盘 → reviewState=awaiting 残留 ═══
  {
    const session = join(work, 'f1-session.jsonl');
    const m = spawnMock('repro-dismiss-no-persist', { sessionPath: session });
    m.send({ id: 's', type: 'switch_session', sessionPath: session });
    await m.waitFor((f) => f.id === 's');
    m.send({ id: 'p', type: 'prompt', message: '/plan 给设置页加主题切换' });
    await m.waitFor((f) => f.method === 'select' && String(f.title).includes('TAIJI_PLAN_REVIEW'));
    m.send({ id: 'a', type: 'abort' });
    await m.waitFor((f) => f.type === 'agent_end');
    const probe = deriveProbe(session);
    const entries = readFileSync(session, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const last = entries.at(-1);
    const ok = entries.length === 1 && last?.data?.reviewState === 'awaiting' && probe.view?.reviewState === 'awaiting';
    record('F1', ok, `忽略后零新 entry，末条 plan-state 仍 reviewState=awaiting；派生 View=${JSON.stringify(probe.view?.reviewState)} stage=${probe.stage}`);
    m.proc.kill('SIGKILL');
    sections.push([
      '## F1 忽略「没反应」',
      '',
      '**症状**：点「忽略」后审批条不消失，切到降级分支（沙漏 +「等待 agent 重新提交审批」）——用户视角 = 没反应。',
      '',
      '**机制链**：runtime 摘除挂起请求是通的；断在显示公式 —— `PlanReviewBar.shouldRender = isActive && (hasPending || reviewState ∈ {awaiting, revising})`，而扩展 cancelled 分支（`tool.ts executeSubmitReview` 的 `choice === undefined` 出口）**不改 reviewState 也不落盘** → awaiting 残留恒真。',
      block('实跑（mock pi 剧本 repro-dismiss-no-persist + derive-probe）',
        `abort 后 session entries: ${entries.length} 条（0 新增）\n末条 data.reviewState = ${JSON.stringify(last?.data?.reviewState)}\n派生 View.reviewState = ${JSON.stringify(probe.view?.reviewState)}\nderivePlanStage = ${JSON.stringify(probe.stage)}\n判定：忽略动作在持久/派生层留下 awaiting 残留 → F1 显示公式输入成立`),
      block('GUI 层构造法（U6 执行）',
        '1. install-mock-pi --scenario repro-dismiss-no-persist → 真机走 S1 至审批条 ready；\n2. 点「忽略」→ 断言审批条未整条消失（降级分支 plan-review-degraded 出现）；\n3. CDP 断言（负向）：suppress 断言此处**应红**（现版确实闪 degraded——基线期是症状，修复后转绿）；\n4. 结束 restore 三证恢复。'),
      block('代码锚点', anchor('packages/renderer/src/components/panel/plan/PlanReviewBar.vue', /reviewState|shouldRender/) + '\n' +
        anchor('extensions/universal/plan/src/tool.ts', /The review was cancelled/)),
    ].join('\n'));
  }

  // ═══ F2 忽略语义自相矛盾：agent 收到「停止等待」，UI 显示「等待 agent」 ═══
  {
    const extCopy = anchor('extensions/universal/plan/src/tool.ts', /The review was cancelled/, 2);
    const zhCopy = anchor('packages/renderer/src/i18n/locales/zh-CN/plan.ts', /waitingResubmit|degradedRecoverHint/, 4);
    const enCopy = anchor('packages/renderer/src/i18n/locales/en-US/plan.ts', /waitingResubmit|degradedRecoverHint/, 4);
    const ok = extCopy.includes('The review was cancelled') && zhCopy.includes('等待 agent 重新提交') && enCopy.includes('remind the agent');
    record('F2', ok, '双侧文案矛盾实证：扩展给 agent「停止等待用户指示」 vs UI 给用户「等待 agent 重新提交」');
    sections.push([
      '## F2 忽略语义自相矛盾',
      '',
      '**症状**：同一次忽略——agent 被告知「取消 ≠ 批准，停止审阅循环、等用户指示」；UI 告诉用户「等待 agent 重新提交审批 / 发任意消息提醒 agent」。两边互相等对方，且 UI 描述的是一个不会发生的事。',
      '',
      '**实跑（现版源文件文案提取）**：',
      block('扩展侧（给 agent 的 tool result）', extCopy),
      block('UI 侧（给用户的降级文案）', `${zhCopy}\n${enCopy}`),
      block('GUI 层构造法（U6 执行）',
        '走 F1 构造法至点「忽略」后：对照对话流 agent 收尾消息（mock 剧本已携带现版 cancelled 文案）与降级分支文案 `plan-review-degraded-hint`，截图留档 S2/A2。'),
    ].join('\n'));
  }

  // ═══ F3 被忽略的审批重启后复活：awaiting 残留 + E3 steer 重挂 ═══
  {
    const session = join(work, 'f3-session.jsonl');
    const m = spawnMock('repro-dismiss-no-persist', { sessionPath: session });
    m.send({ id: 's', type: 'switch_session', sessionPath: session });
    await m.waitFor((f) => f.id === 's');
    m.send({ id: 'p', type: 'prompt', message: '/plan x' });
    await m.waitFor((f) => f.method === 'select' && String(f.title).includes('TAIJI_PLAN_REVIEW'));
    m.send({ id: 'a', type: 'abort' });
    await m.waitFor((f) => f.type === 'agent_end');
    m.proc.kill('SIGKILL');
    // 「重开 session」= 对同一持久文件重新派生（E3 的 reconstructPlanState 读同一条 entry）
    const probe = deriveProbe(session);
    const e3 = anchor('extensions/universal/plan/src/index.ts', /reviewState === "awaiting"|reviewState === "revising"|reviewStateSource = "resubmit"|E3/, 8);
    const ok = probe.view?.reviewState === 'awaiting' && e3.includes('reviewState === "awaiting"');
    record('F3', ok, `持久态 reviewState=${JSON.stringify(probe.view?.reviewState)} 经重开派生仍存活 + E3 恢复分支条件成立 → steer 重挂（复活链完备）`);
    sections.push([
      '## F3 被忽略的审批重启后复活',
      '',
      '**症状**：用户显式关掉的提问，重开会话后卷土重来（E3 看到 awaiting 就 steer agent「立即重新 submit-review」）。',
      '',
      '**机制链**：忽略不落任何盘（F1）→ entry 里 `reviewState=\'awaiting\'` 原样残留 → session_start 的 E3 恢复逻辑分支命中 → steer 重挂。',
      block('实跑（F1 持久态 + 重开派生 + E3 分支锚点）',
        `重开派生 View.reviewState = ${JSON.stringify(probe.view?.reviewState)}\nE3 恢复分支条件成立（见锚点）→ steer「重新 submit-review」+ reviewStateSource='resubmit' 落盘`),
      block('GUI 层构造法（U6 执行）',
        '1. F1 构造法至忽略后杀 pi（mock 剧本 crash-immediate 亦可）；2. 重开该 session 发任意消息触发重生；3. 断言审批条重新出现（复活）或对话流出现 E3 重挂 steer —— 基线期为症状，修复后 S2「重开不复活」转绿。'),
      block('代码锚点', e3),
    ].join('\n'));
  }

  // ═══ F4 abort 链两个结构性缺口 ═══
  {
    const session = join(work, 'f4-session.jsonl');
    const m = spawnMock('crash-on-abort', { sessionPath: session });
    m.send({ id: 's', type: 'switch_session', sessionPath: session });
    await m.waitFor((f) => f.id === 's');
    m.send({ id: 'p', type: 'prompt', message: '/plan x' });
    await m.waitFor((f) => f.method === 'select' && String(f.title).includes('TAIJI_PLAN_REVIEW'));
    m.send({ id: 'a', type: 'abort' });
    await new Promise((r) => setTimeout(r, 800));
    const abortAnswered = m.frames.some((f) => f.id === 'a');
    const exitObserved = await new Promise((r) => {
      if (m.proc.exitCode !== null || m.proc.signalCode !== null) r(true);
      else m.proc.on('exit', () => r(true));
    });
    const ok = !abortAnswered && exitObserved;
    record('F4', ok, `abort 应答 800ms 窗口内缺席（answered=${abortAnswered}）+ 进程退出可观测（exit=${exitObserved}）→ abort RPC 无法完成形态构造成功`);

    // abort-unanswered 变体（60s 阶梯窗口）
    const m2 = spawnMock('abort-unanswered', { sessionPath: session });
    m2.send({ id: 'p', type: 'prompt', message: '/plan x' });
    await m2.waitFor((f) => f.method === 'select');
    m2.send({ id: 'a2', type: 'abort' });
    await new Promise((r) => setTimeout(r, 500));
    const silent = !m2.frames.some((f) => f.id === 'a2');
    m2.proc.kill('SIGKILL');
    m.proc.kill('SIGKILL');

    const abortBody = anchor('packages/runtime/src/transport/session-message-handler.ts', /handleMessageAbort|invalidatePendingUiRequests|sessionService\.abort|finally/, 10);
    sections.push([
      '## F4 abort 链两个结构性缺口',
      '',
      '**症状**：① pi 不在活跃表时 abort 抛错、invalidate 被跳过 → 审批条永久 ready 残留（僵尸）；② abort RPC 60s 超时阶梯期间失效帧迟到，renderer 65s backstop 先报错。',
      '',
      block('实跑（mock pi 崩溃注入 crash-on-abort + abort 无应答 abort-unanswered）',
        `crash-on-abort：abort 发出后 800ms 应答缺席（answered=${abortAnswered}），进程退出可观测（${exitObserved}）\nabort-unanswered：abort 发出后 500ms 应答缺席（silent=${silent}）\n判定：「abort RPC 无法完成」前置形态构造成功（F4① 的 throw 面 / F4② 的阶梯窗口面）`),
      block('GUI 层构造法（U6 执行）',
        '1. install-mock-pi --scenario crash-on-abort → 走 S1 至审批条 ready；2. 点 composer ■ 停止（或「忽略」旧链）触发 message.abort；3. 断言审批条 ready 是否残留（F4① 症状面）；4. abort-unanswered 变体观察 65s backstop 错误行（F4②，分钟级窗口按需截断）。'),
      block('代码锚点（采集时实测状态——D6 修复是否已落，以文件头 git HEAD / 工作树快照为准）', abortBody),
    ].join('\n'));
  }

  // ═══ F5 阶段指示倒退：executeComplete 先清 reviewState 再挂表单 ═══
  {
    const session = join(work, 'f5-session.jsonl');
    const m = spawnMock('repro-exec-form-pending', { sessionPath: session });
    m.send({ id: 's', type: 'switch_session', sessionPath: session });
    await m.waitFor((f) => f.id === 's');
    m.send({ id: 'p', type: 'prompt', message: '/plan x' });
    const sel = await m.waitFor((f) => f.method === 'select' && String(f.title).includes('TAIJI_PLAN_REVIEW'));
    m.send({ id: sel.id, value: JSON.stringify({ decision: 'approve' }) });
    await m.waitFor((f) => f.method === 'select' && String(f.title).includes('TAIJI_UI_FORM'));
    const probe = deriveProbe(session);
    const ok = probe.view?.reviewState === undefined && probe.view?.docs?.length === 1 && probe.stage === 'writing';
    record('F5', ok, `执行方式表单挂起中派生 View=${JSON.stringify({ reviewState: probe.view?.reviewState, docs: probe.view?.docs?.length })} → derivePlanStage=${JSON.stringify(probe.stage)}（「②文档撰写」倒退实证，应为③）`);
    m.proc.kill('SIGKILL');
    sections.push([
      '## F5 阶段指示倒退',
      '',
      '**症状**：确认执行后执行方式表单挂起期间，三步指示从「③审阅确认」打回「②文档撰写」——用户正在选执行方式，进度条却在倒退。',
      '',
      '**机制链**：`executeComplete`（tool.ts）先清 reviewState 落盘、再挂执行方式表单 → 表单挂起期持久态 = `isActive + docs>0 + 无 reviewState` → `derivePlanStage` 据此判「②文档撰写」。',
      block('实跑（mock pi 剧本 repro-exec-form-pending + derive-probe，直接调用现版 derivePlanStage）',
        `approve 应答后 entry：reviewState 已清（executeComplete 先清序模拟）+ docs=1 + 执行方式表单 select 挂起\n派生 View.reviewState = ${JSON.stringify(probe.view?.reviewState)}\nderivePlanStage = ${JSON.stringify(probe.stage)} ← 「②文档撰写」（表单挂起期应为「③审阅确认」）`),
      block('GUI 层构造法（U6 执行）',
        '1. install-mock-pi --scenario repro-exec-form-pending → 走 S1 至审批条 ready；2. 点「确认执行」→ 表单挂起；3. 断言状态带阶段点停在③（基线期为症状②闪退，修复后 S5「无阶段倒退」转绿）。'),
      block('代码锚点',
        anchor('extensions/universal/plan/src/tool.ts', /persistPlanState\(pi, state\);|const choice = await resolveCompleteChoice/, 6) + '\n' +
        anchor('packages/renderer/src/stores/plan-store.ts', /export function derivePlanStage|reviewState === 'awaiting'|return 'writing'/, 6)),
    ].join('\n'));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const summary = repros.map((r) => `| ${r.id} | ${r.ok ? '✅ 复现成功' : '❌ 未复现'} | ${r.verdict} |`).join('\n');
const doc = `${head}

## 复现汇总

| 症状 | 结果 | 关键证据 |
|------|------|----------|
${summary}

## deviations 说明（与设计的偏离点）

1. **GUI 层复现未在本基线实跑**：F1-F5 的渲染态症状复现需 dev 实例 + CDP 交互编排（跨窗口资产），本基线以协议/持久/派生层实跑 + GUI 构造法（逐条上文）覆盖；真机执行归 U6 验收窗（设计 §4 S1-S16 场景表）。
2. **F4① 序缺陷子症状可能已修复于采集基线**：D6（invalidate 前置 + try/finally）由 U3a 落地——采集时源码锚点实测已呈修复态（具体以文件头 git HEAD / 工作树快照为准）；基线保留「abort RPC 无法完成」前置形态的协议层实跑证据（该形态与 D6 修复解耦，仍服务 F4② 阶梯窗口与极端失败三态分裂的验收构造）。
${sections.join('\n')}
`;

if (outPath) {
  writeFileSync(outPath, doc);
  console.log(`\nbaseline written: ${outPath}`);
}
const allOk = repros.every((r) => r.ok);
console.log(`repro-baseline: ${repros.filter((r) => r.ok).length}/${repros.length} reproduced`);
process.exit(allOk && repros.length === 5 ? 0 : 1);

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}
