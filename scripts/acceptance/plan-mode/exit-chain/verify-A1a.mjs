#!/usr/bin/env node
/**
 * A1a 验收驱动（plan-mode-audit-remediation V1 exit 链八场景，L3 脚本端到端）。
 *
 * 被测对象 = extensions/universal/plan 的 pi extension（exitPlanMode 单入口等已实施代码）。
 * 驱动形态：真实 pi 以 `-ne --mode rpc --session-dir <tmp> --approve --extension <plan 入口>`
 * 起进程（-ne 防 settings 清单双载），stdin JSONL 发帧驱动；LLM 环节由本地 mock LLM server
 * （OpenAI chat/completions 流式，models.json 自定义 provider 指向 127.0.0.1）按剧本应答，
 * 零外部 token。
 *
 * 八场景（设计 §4 V1 行，④a/④b/⑥ 已按设计沉淀为单测、不在本剧本）：
 *   ① 审批挂起中 /plan abort
 *   ② 审批挂起中 agent 调 plan 工具 abort（同批 [submit-review, abort] sequential 顺序执行）
 *   ③ 执行方式表单挂起中 /plan abort（fixture-skill 触发表单）
 *   ⑤ plan 已 complete 终局后再调 plan 工具 abort
 *   ⑦ 退出后重开会话不复活
 *   ⑧ idle 格（从未进 plan）双通道 abort 各一次
 *   ⑨a 坏格终态残留（手写 session entry completed+isActive=true）abort 清洗 + 二次重开不复活
 *   ⑨b 坏格 idle 残留（手写 session entry idle+isActive=true）abort 清洗 + 二次重开不复活
 *
 * 用法：node verify-A1a.mjs <artifactsDir>
 * 退出码：0 = 八场景全 PASS；1 = 存在 FAIL（明细见 <artifactsDir>/scenarios.md 与 scenes/*.log）。
 */
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '../../../..');
const PLAN_ENTRY = join(REPO, 'extensions/universal/plan/index.ts');
const PI_BIN = join(REPO, 'node_modules/.bin/pi');
const FIXTURE_SKILL = join(REPO, 'scripts/acceptance/plan-mode/fixture-skill/fixture-skill.mjs');

const ARTIFACTS = process.argv[2] ?? join(REPO, '.tmp/dev-flow/plan-mode-audit-remediation.artifacts/verify-A1a');
mkdirSync(join(ARTIFACTS, 'scenes'), { recursive: true });

// ── 契约常量（与实装同源字面量：extension-protocol markers / plan tool 文案锚）──
const PLAN_REVIEW_MARKER = '\x00TAIJI_PLAN_REVIEW:';
const UI_FORM_MARKER = '\x00TAIJI_UI_FORM';
const NOTIFY_ABORT_OK = 'Plan mode aborted.';
const NOTIFY_ABORT_TOOL_TEXT = 'Plan mode aborted. Full tool access restored.';
const NOTIFY_IDLE_WARN = 'No active plan mode.';
const NOTIFY_INACTIVE_WARN_PREFIX = 'Plan mode is not active (it already completed or exited)';
const CANCELLED_BY_EXIT_TEXT = 'Plan mode has been exited and the full tool set is restored.';
const FORM_PENDING_EXIT_TEXT = 'Plan mode has been exited while the execution-method prompt was pending';
const PLAN_MODE_TOOLS = ['read', 'bash', 'grep', 'find', 'ls', 'plan'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock LLM server ──────────────────────────────────────────────────
/**
 * 每个场景一个实例。剧本应答经 responses 队列推入：元素为数组（同批多 tool call）或
 * 单对象 {tool:{name,args}} / {text}。请求 body（含 tools 名单与 messages）记录进 requests。
 */
function makeLlmServer() {
  const responses = [];
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      requests.push(parsed);
      const next = responses.shift();
      if (!next) {
        // 剧本外请求（意外轮次）：500 会让 pi 该轮报错，不静默编造响应
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'verify-A1a: no scripted LLM response queued' } }));
        return;
      }
      const spec = next(parsed);
      const tools = Array.isArray(spec) ? spec : [spec];
      const chunks = [];
      const base = { id: 'chatcmpl-a1a', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
      if (tools[0].tool) {
        tools.forEach((t, i) => {
          chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name: t.tool.name, arguments: '' } }] }, finish_reason: null }] });
          chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(t.tool.args) } }] }, finish_reason: null }] });
        });
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: tools[0].text }, finish_reason: null }] });
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      if (process.env.A1A_DEBUG) console.error(`[llm] req#${requests.length - 1} -> ${JSON.stringify(chunks[0]).slice(0, 200)} (queued left: ${responses.length})`);
    });
  });
  return { responses, requests, server };
}

// ── pi 进程编排 ──────────────────────────────────────────────────────
function makeWorkspace(name) {
  const WORK = mkdtempSync(join(tmpdir(), `plan-a1a-${name}-`));
  const AGENT_DIR = join(WORK, 'agent-dir');
  const PROJECT = join(WORK, 'project');
  const SESSIONS = join(WORK, 'sessions');
  const HOME = join(WORK, 'home');
  for (const d of [AGENT_DIR, PROJECT, SESSIONS, HOME]) mkdirSync(d, { recursive: true });
  return { WORK, AGENT_DIR, PROJECT, SESSIONS, HOME };
}

function startPi(ws, llm, { sessionFile } = {}) {
  const frames = [];
  const args = [
    '-ne', '--mode', 'rpc', '--session-dir', ws.SESSIONS, '--approve',
    '--extension', PLAN_ENTRY, '--model', 'mock-llm/mock-model',
  ];
  if (sessionFile) args.push('--session', sessionFile);
  const child = spawn(PI_BIN, args, {
    cwd: ws.PROJECT,
    // PI_CODING_AGENT_DIR 隔离 models/settings；HOME 隔离 ~/.agents/skills 扫描（fixture 由场景显式投放）；
    // TAIJI_AGENT_EXT_LOG=1 = isTaijiHost 信号，rpc mode 下走 GUI 挂起交互形态（marker select）
    env: { ...process.env, PI_CODING_AGENT_DIR: ws.AGENT_DIR, TAIJI_AGENT_EXT_LOG: '1', HOME: ws.HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.setEncoding('utf8');
  const waiters = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let f;
    try { f = JSON.parse(t); } catch { return; }
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) waiters.splice(i, 1)[0].resolve(f);
    }
  });
  const api = {
    frames, requests: llm.requests, responses: llm.responses, child, stderr: () => stderr,
    send: (o) => child.stdin.write(`${JSON.stringify(o)}\n`),
    wait: (pred, label, timeoutMs = 30000) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout(${label}): ${stderr.slice(-800)}`)), timeoutMs);
      waiters.push({ pred, resolve: (f) => { clearTimeout(t); res(f); } });
    }),
    waitSettled: (timeoutMs = 60000) => api.wait((f) => f.type === 'agent_settled', 'agent_settled', timeoutMs),
    rpcReady: async () => {
      const id = `ready-${Math.random().toString(36).slice(2, 8)}`;
      api.send({ type: 'get_state', id });
      await api.wait((f) => f.type === 'response' && f.id === id && f.success, 'get_state ready', 60000);
    },
  };
  return api;
}

async function stopPi(api) {
  if (!api.child.exitCode && api.child.pid) {
    api.child.stdin.end();
    const exited = await Promise.race([
      new Promise((r) => api.child.once('exit', r)),
      sleep(5000).then(() => null),
    ]);
    if (exited === null) {
      try { api.child.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }
}

// ── 断言与检查器 ─────────────────────────────────────────────────────
function assert(cond, msg) {
  if (!cond) throw new Error(`assert: ${msg}`);
}

function sessionFileOf(ws) {
  const f = readdirSync(ws.SESSIONS).find((x) => x.endsWith('.jsonl'));
  return f ? join(ws.SESSIONS, f) : null;
}

/** 读 session JSONL 全部行（pi 未 flush 时文件可能不存在） */
function readSessionLines(ws) {
  const f = sessionFileOf(ws);
  if (!f) return [];
  try {
    return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function planEntriesOf(ws) {
  return readSessionLines(ws)
    .filter((e) => e.type === 'custom' && e.customType === 'plan-state')
    .map((e) => e.data);
}

function notifyFrames(api, method = 'notify') {
  return api.frames.filter((f) => f.type === 'extension_ui_request' && f.method === method);
}

function toolEndsOf(api, action) {
  return api.frames.filter((f) => f.type === 'tool_execution_end' && f.toolName === 'plan'
    && f.result?.details?.action === action);
}

function toolResultText(f) {
  return f.result?.content?.map((c) => c.text).join('\n') ?? '';
}

function lastRequestTools(llm) {
  const req = llm.requests[llm.requests.length - 1];
  return (req?.tools ?? []).map((t) => t.function?.name);
}

/** 在 cwd 投放 plan-exec fixture skill（场景③表单前提；fixture-skill.mjs 自带安全网标记与清理入口） */
function plantFixtureSkill(projectDir) {
  execFileSync(process.execPath, [FIXTURE_SKILL, 'create', '--dir', projectDir], { stdio: 'pipe' });
}

// ── 共用驱动序列 ─────────────────────────────────────────────────────
/** 进入 plan 并挂起审批 select，返回该 select 请求帧。前置：responses 队列已排好 enter/register/submit */
async function driveToReviewPending(api) {
  api.send({ type: 'prompt', id: `p-${Math.random().toString(36).slice(2, 8)}`, message: 'start planning (driven)' });
  return api.wait((f) => f.type === 'extension_ui_request' && f.method === 'select' && f.title === PLAN_REVIEW_MARKER, 'review select pending', 60000);
}

/** 审批 select 应答 */
function answerSelect(api, selectFrame, value) {
  api.send({ type: 'extension_ui_response', id: selectFrame.id, value });
}

// ── 场景 ─────────────────────────────────────────────────────────────
/** ① 审批挂起中 /plan abort */
async function scene1(log) {
  const ws = makeWorkspace('s1');
  const llm = makeLlmServer();
  await new Promise((r) => llm.server.listen(0, '127.0.0.1', r));
  writeFileSync(join(ws.AGENT_DIR, 'models.json'), JSON.stringify({
    providers: { 'mock-llm': { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k', api: 'openai-completions', models: [{ id: 'mock-model', name: 'Mock Model' }] } },
  }));
  const api = startPi(ws, llm);
  try {
    await api.rpcReady();
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'enter', requirement: 'scene1 req' } } }]);
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'register-doc', fileName: 'plan.md' } } }]);
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'submit-review', selfReview: 'scene1 self review' } } }]);
    const select = await driveToReviewPending(api);
    assert(select.title === PLAN_REVIEW_MARKER, 'review select hanged with marker title');

    // 挂起中 slash abort（streaming 中 extension command 即时执行，不经 LLM）
    const abortId = 'abort-s1';
    api.send({ type: 'prompt', id: abortId, message: '/plan abort' });
    await api.wait((f) => f.type === 'response' && f.id === abortId && f.success, 'abort prompt ack');
    llm.responses.push(() => ({ text: 'stopped by user' }));
    await api.waitSettled();
    await sleep(300);

    const ok = notifyFrames(api).find((f) => f.message === NOTIFY_ABORT_OK);
    assert(ok, `notify info "${NOTIFY_ABORT_OK}" present`);
    assert(ok.notifyType === 'info', 'exit notify level info');
    const cancelledEnd = toolEndsOf(api, 'review-error').find((f) => toolResultText(f).includes(CANCELLED_BY_EXIT_TEXT));
    assert(cancelledEnd, 'submit-review settled with self-dissolved cancelled correction text');
    const entries = planEntriesOf(ws);
    const last = entries[entries.length - 1];
    assert(last?.state === 'exited' && last?.isActive === false, `final entry exited+inactive, got ${JSON.stringify(last)}`);
    const tools = lastRequestTools(llm);
    assert(tools.includes('edit') && tools.includes('write'), `full tool set restored, got ${tools.join(',')}`);
    assert(tools.includes('plan'), 'plan tool kept for reentry');
    log('PASS ① 审批挂起中 /plan abort：审批 select 解散、exited 落盘、notify info、工具集恢复全量且 plan 保留、turn 正常收敛');
  } finally {
    await stopPi(api);
    llm.server.close();
    dumpScene(api, 'scene1');
    rmSync(ws.WORK, { recursive: true, force: true });
  }
}

/** ② 审批挂起中 agent 调 plan 工具 abort（同批 [submit-review, abort] sequential 顺序执行） */
async function scene2(log) {
  const ws = makeWorkspace('s2');
  const llm = makeLlmServer();
  await new Promise((r) => llm.server.listen(0, '127.0.0.1', r));
  writeFileSync(join(ws.AGENT_DIR, 'models.json'), JSON.stringify({
    providers: { 'mock-llm': { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k', api: 'openai-completions', models: [{ id: 'mock-model', name: 'Mock Model' }] } },
  }));
  const api = startPi(ws, llm);
  try {
    await api.rpcReady();
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'enter', requirement: 'scene2 req' } } }]);
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'register-doc', fileName: 'plan.md' } } }]);
    llm.responses.push(() => [
      { tool: { name: 'plan', args: { action: 'submit-review', selfReview: 'scene2 self review' } } },
      { tool: { name: 'plan', args: { action: 'abort' } } },
    ]);
    const select = await driveToReviewPending(api);
    // 审批交互存续期间（挂起未终局）应答 dismiss → 同批第二个 tool call（abort）随后执行
    answerSelect(api, select, JSON.stringify({ decision: 'dismiss' }));
    llm.responses.push(() => ({ text: 'done scene2' }));
    await api.waitSettled();
    await sleep(300);

    const dismissedEnd = toolEndsOf(api, 'review-dismissed');
    assert(dismissedEnd.length === 1, 'submit-review settled as dismissed');
    const abortEnd = toolEndsOf(api, 'abort');
    assert(abortEnd.length === 1, 'abort tool executed after dismiss (sequential batch order)');
    assert(toolResultText(abortEnd[0]) === NOTIFY_ABORT_TOOL_TEXT, `abort tool result text, got "${toolResultText(abortEnd[0])}"`);
    const entries = planEntriesOf(ws);
    const last = entries[entries.length - 1];
    assert(last?.state === 'exited' && last?.isActive === false, `final entry exited+inactive, got ${JSON.stringify(last)}`);
    const tools = lastRequestTools(llm);
    assert(tools.includes('edit') && tools.includes('write'), `full tool set restored, got ${tools.join(',')}`);
    log('PASS ② 审批挂起中 agent 调 plan 工具 abort：同批 sequential 顺序执行、dismiss 后 abort 成功退出（tool result 确认文案）、exited 落盘、工具集恢复、无挂死');
  } finally {
    await stopPi(api);
    llm.server.close();
    dumpScene(api, 'scene2');
    rmSync(ws.WORK, { recursive: true, force: true });
  }
}

/** ③ 执行方式表单挂起中 /plan abort（fixture-skill 触发表单，归口② self no-op） */
async function scene3(log) {
  const ws = makeWorkspace('s3');
  plantFixtureSkill(ws.PROJECT);
  const llm = makeLlmServer();
  await new Promise((r) => llm.server.listen(0, '127.0.0.1', r));
  writeFileSync(join(ws.AGENT_DIR, 'models.json'), JSON.stringify({
    providers: { 'mock-llm': { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k', api: 'openai-completions', models: [{ id: 'mock-model', name: 'Mock Model' }] } },
  }));
  const api = startPi(ws, llm);
  try {
    await api.rpcReady();
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'enter', requirement: 'scene3 req' } } }]);
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'register-doc', fileName: 'plan.md' } } }]);
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'submit-review', selfReview: 'scene3 self review' } } }]);
    const review = await driveToReviewPending(api);
    answerSelect(api, review, JSON.stringify({ decision: 'approve' }));
    // approve → complete → 执行方式表单挂起（fixture skill 已检测）
    const form = await api.wait((f) => f.type === 'extension_ui_request' && f.method === 'select' && f.title === UI_FORM_MARKER, 'exec-form select pending', 60000);
    assert(Array.isArray(form.options) && JSON.stringify(form.options[0]).includes('Execution method'), 'exec-form options carried formQuestions');

    // 表单挂起中 slash abort
    const abortId = 'abort-s3';
    api.send({ type: 'prompt', id: abortId, message: '/plan abort' });
    await api.wait((f) => f.type === 'response' && f.id === abortId && f.success, 'abort prompt ack');
    llm.responses.push(() => ({ text: 'done scene3' }));
    llm.responses.push(() => ({ text: 'done scene3 extra' })); // 兜底意外轮
    await api.waitSettled();
    await sleep(300);

    const ok = notifyFrames(api).find((f) => f.message === NOTIFY_ABORT_OK);
    assert(ok, `notify info "${NOTIFY_ABORT_OK}" present`);
    const entries = planEntriesOf(ws);
    const states = entries.map((e) => `${e.state}/${e.isActive}`);
    assert(entries.length === 5, `exactly 5 plan entries (enter/register/submit/dispatching/exit), got ${entries.length}: ${states.join(' | ')}`);
    assert(entries[3].state === 'dispatching' && entries[3].isActive === true, 'dispatching persisted before form (approve-edge anchor)');
    const last = entries[4];
    assert(last.state === 'exited' && last.isActive === false, `final entry exited+inactive, got ${JSON.stringify(last)}`);
    const submitEnd = api.frames.filter((f) => f.type === 'tool_execution_end' && f.toolName === 'plan'
      && f.result?.details?.action === 'complete-cancelled');
    assert(submitEnd.length === 1 && toolResultText(submitEnd[0]).includes(FORM_PENDING_EXIT_TEXT), 'complete-cancelled归口 self no-op text present, no extra persist');
    const tools = lastRequestTools(llm);
    assert(tools.includes('edit') && tools.includes('write'), `full tool set restored, got ${tools.join(',')}`);
    log('PASS ③ 执行方式表单挂起中 /plan abort：UI_FORM select 解散、归口② self no-op 不落盘、exited 落盘（dispatching 保留）、工具集恢复、无挂死');
  } finally {
    await stopPi(api);
    llm.server.close();
    dumpScene(api, 'scene3');
    rmSync(ws.WORK, { recursive: true, force: true });
  }
}

/** ⑤ plan 已 complete 终局后再调 plan 工具 abort（无 fixture skill → complete 直通终局） */
async function scene5(log) {
  const ws = makeWorkspace('s5');
  const llm = makeLlmServer();
  await new Promise((r) => llm.server.listen(0, '127.0.0.1', r));
  writeFileSync(join(ws.AGENT_DIR, 'models.json'), JSON.stringify({
    providers: { 'mock-llm': { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k', api: 'openai-completions', models: [{ id: 'mock-model', name: 'Mock Model' }] } },
  }));
  const api = startPi(ws, llm);
  try {
    await api.rpcReady();
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'enter', requirement: 'scene5 req' } } }]);
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'register-doc', fileName: 'plan.md' } } }]);
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'submit-review', selfReview: 'scene5 self review' } } }]);
    // 第 4 轮 = complete 直通（no-exec-skills）后的 steer 执行通知轮；队列恰耗尽，
    // 给第二段（abort 调用）留干净队列——编排依据见 dumpScene(scene5-run1) 帧日志
    llm.responses.push(() => ({ text: 'approved message delivered' }));
    const review = await driveToReviewPending(api);
    answerSelect(api, review, JSON.stringify({ decision: 'approve' }));
    await api.waitSettled();
    await sleep(300);

    const entriesBefore = planEntriesOf(ws);
    const completed = entriesBefore[entriesBefore.length - 1];
    assert(completed.state === 'completed' && completed.isActive === false, `completed terminal persisted, got ${JSON.stringify(completed)}`);

    // 终局后再调 plan 工具 abort：新 prompt → LLM 返回 abort tool call
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'abort' } } }]);
    llm.responses.push(() => ({ text: 'acknowledged inactive' }));
    const p2 = 'p-s5-abort';
    api.send({ type: 'prompt', id: p2, message: 'try to abort the finished plan' });
    await api.waitSettled();
    await sleep(300);

    const entriesAfter = planEntriesOf(ws);
    assert(entriesAfter.length === entriesBefore.length, `no new plan-state entry after abort on completed (免覆写), before=${entriesBefore.length} after=${entriesAfter.length}`);
    const lastAfter = entriesAfter[entriesAfter.length - 1];
    assert(lastAfter.state === 'completed' && lastAfter.isActive === false, `completed entry intact, got ${JSON.stringify(lastAfter)}`);
    // tool 路反馈不走 notify（那是 command 路投影）：纠偏指令语义承载于 tool result 文本（A9）
    const inactiveEnd = toolEndsOf(api, 'review-error').filter((f) => toolResultText(f).startsWith(NOTIFY_INACTIVE_WARN_PREFIX));
    assert(inactiveEnd.length === 1, `abort tool result carried inactive correction text, got ${inactiveEnd.map(toolResultText)}`);
    const tools = lastRequestTools(llm);
    assert(tools.includes('edit') && tools.includes('write') && tools.includes('plan'), `tool set untouched (full), got ${tools.join(',')}`);
    log('PASS ⑤ completed 终局后再调 abort：completed entry 免覆写无新落盘、tool result 纠偏指令反馈（tool 路投影）、状态面已退出态幂等、无副作用');
  } finally {
    await stopPi(api);
    llm.server.close();
    dumpScene(api, 'scene5');
    rmSync(ws.WORK, { recursive: true, force: true });
  }
}

/** ⑦ 退出后重开会话不复活 */
async function scene7(log) {
  const ws = makeWorkspace('s7');
  const llm = makeLlmServer();
  await new Promise((r) => llm.server.listen(0, '127.0.0.1', r));
  writeFileSync(join(ws.AGENT_DIR, 'models.json'), JSON.stringify({
    providers: { 'mock-llm': { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k', api: 'openai-completions', models: [{ id: 'mock-model', name: 'Mock Model' }] } },
  }));
  let sessionFile;
  const api1 = startPi(ws, llm);
  try {
    await api1.rpcReady();
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'enter', requirement: 'scene7 req' } } }]);
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'register-doc', fileName: 'plan.md' } } }]);
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'submit-review', selfReview: 'scene7 self review' } } }]);
    const select = await driveToReviewPending(api1);
    const abortId = 'abort-s7';
    api1.send({ type: 'prompt', id: abortId, message: '/plan abort' });
    await api1.wait((f) => f.type === 'response' && f.id === abortId && f.success, 'abort prompt ack');
    llm.responses.push(() => ({ text: 'stopped' }));
    await api1.waitSettled();
    await sleep(300);
    sessionFile = sessionFileOf(ws);
    assert(sessionFile, 'session file persisted');
    const entriesAfterExit = planEntriesOf(ws);
    assert(entriesAfterExit[entriesAfterExit.length - 1].state === 'exited', 'exited before reopen');
  } finally {
    await stopPi(api1);
    dumpScene(api1, 'scene7-run1');
  }

  // 重开：同 session 文件新 pi 进程
  const framesBefore = llm.requests.length;
  void framesBefore;
  const entryCountBefore = planEntriesOf(ws).length;
  const api2 = startPi(ws, llm, { sessionFile });
  try {
    await api2.rpcReady();
    await sleep(600); // session_start hook（E3 恢复分流若有会在此 steer 重挂）
    assert(!api2.frames.some((f) => f.type === 'extension_ui_request' && f.title === PLAN_REVIEW_MARKER), 'no review select re-hung on reopen');
    // 首轮 LLM 请求：工具集应为全量（isActive=false 不收拢白名单）
    llm.responses.push(() => ({ text: 'reopened fine' }));
    api2.send({ type: 'prompt', id: 'p-s7', message: 'status check after reopen' });
    await api2.waitSettled();
    const tools = lastRequestTools(llm);
    assert(tools.includes('edit') && tools.includes('write'), `full tool set on reopen (not restricted), got ${tools.join(',')}`);
    const entryCountAfter = planEntriesOf(ws).length;
    assert(entryCountAfter === entryCountBefore, `no new plan-state entry on reopen, before=${entryCountBefore} after=${entryCountAfter}`);
    log('PASS ⑦ 退出后重开会话：无审批条复活（无 PLAN_REVIEW select）、工具集全量不收拢、零新落盘');
  } finally {
    await stopPi(api2);
    llm.server.close();
    dumpScene(api2, 'scene7-run2');
    rmSync(ws.WORK, { recursive: true, force: true });
  }
}

/** ⑧ idle 格双通道 abort：slash 路 + tool 路各一次，两通道一致（无落盘 + warn 纠偏） */
async function scene8(log) {
  const ws = makeWorkspace('s8');
  const llm = makeLlmServer();
  await new Promise((r) => llm.server.listen(0, '127.0.0.1', r));
  writeFileSync(join(ws.AGENT_DIR, 'models.json'), JSON.stringify({
    providers: { 'mock-llm': { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k', api: 'openai-completions', models: [{ id: 'mock-model', name: 'Mock Model' }] } },
  }));
  const api = startPi(ws, llm);
  try {
    await api.rpcReady();
    assert(planEntriesOf(ws).length === 0, 'idle session starts with zero plan entries');

    // a) slash 路
    const a1 = 'abort-s8-slash';
    api.send({ type: 'prompt', id: a1, message: '/plan abort' });
    await api.wait((f) => f.type === 'response' && f.id === a1 && f.success, 'slash abort ack');
    await sleep(500);
    const slashWarn = notifyFrames(api).filter((f) => f.message === NOTIFY_IDLE_WARN);
    assert(slashWarn.length === 1 && slashWarn[0].notifyType === 'warning', `slash idle abort warns, got ${JSON.stringify(slashWarn.map((w) => [w.message, w.notifyType]))}`);
    assert(planEntriesOf(ws).length === 0, 'slash idle abort persists nothing');

    // b) tool 路
    llm.responses.push(() => [{ tool: { name: 'plan', args: { action: 'abort' } } }]);
    llm.responses.push(() => ({ text: 'nothing to abort' }));
    const p = 'p-s8-tool';
    api.send({ type: 'prompt', id: p, message: 'abort plan mode via tool' });
    await api.waitSettled();
    await sleep(300);
    const idleEnd = toolEndsOf(api, 'review-error').filter((f) => toolResultText(f) === NOTIFY_IDLE_WARN);
    assert(idleEnd.length === 1, `tool idle abort result text, got "${idleEnd[0] ? toolResultText(idleEnd[0]) : '<none>'}"`);
    assert(planEntriesOf(ws).length === 0, 'tool idle abort persists nothing');
    const tools = lastRequestTools(llm);
    assert(tools.includes('edit') && tools.includes('write'), `tool set zero change on idle, got ${tools.join(',')}`);
    log('PASS ⑧ idle 格双通道 abort：两通道一致（无 plan-state 落盘、状态/工具集零变化、warn 纠偏文案——slash notify 与 tool result 同文案）');
  } finally {
    await stopPi(api);
    llm.server.close();
    dumpScene(api, 'scene8');
    rmSync(ws.WORK, { recursive: true, force: true });
  }
}

/**
 * ⑨a/⑨b 共用骨架：正常会话 → 手写坏格 entry（isActive=true）→ 重开复活 → abort 清洗 → 二次重开不复活。
 * badState = 'completed'（⑨a 终态残留）| 'idle'（⑨b idle 残留）。
 * 期望清洗态：⑨a completed 保值；⑨b → exited（清洗例外分派）。
 */
async function badCellScene(log, sceneTag, badState, expectedCleanState) {
  const ws = makeWorkspace(sceneTag);
  const llm = makeLlmServer();
  await new Promise((r) => llm.server.listen(0, '127.0.0.1', r));
  writeFileSync(join(ws.AGENT_DIR, 'models.json'), JSON.stringify({
    providers: { 'mock-llm': { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k', api: 'openai-completions', models: [{ id: 'mock-model', name: 'Mock Model' }] } },
  }));
  let sessionFile;
  // 段1：产生合法会话（assistant 消息触发 flush，session 文件落盘）
  const api1 = startPi(ws, llm);
  try {
    await api1.rpcReady();
    llm.responses.push(() => ({ text: 'seed message' }));
    api1.send({ type: 'prompt', id: 'p-seed', message: 'seed' });
    await api1.waitSettled();
    await sleep(300);
    sessionFile = sessionFileOf(ws);
    assert(sessionFile, 'session file persisted after first assistant message');
    const lines = readSessionLines(ws);
    const lastLine = lines[lines.length - 1];
    // 手写坏格 entry（设计 ⑨ 形态：最后一条 plan-state = isActive=true 的非活跃格）
    const bad = {
      type: 'custom', id: '99999999', parentId: lastLine.id, timestamp: new Date().toISOString(),
      customType: 'plan-state',
      data: {
        isActive: true, planFilePath: join(ws.WORK, 'fake', 'plan.md'), requirement: 'bad cell', templateName: '',
        skills: [], docs: [], state: badState,
      },
    };
    appendFileSync(sessionFile, `${JSON.stringify(bad)}\n`);
  } finally {
    await stopPi(api1);
    dumpScene(api1, `${sceneTag}-run1`);
  }

  // 段2：重开（--session）→ 坏格复活（白名单收拢）→ /plan abort 清洗
  const api2 = startPi(ws, llm, { sessionFile });
  try {
    await api2.rpcReady();
    await sleep(600);
    llm.responses.push(() => ({ text: 'probe tools' }));
    api2.send({ type: 'prompt', id: 'p-probe', message: 'what can you do' });
    await api2.waitSettled();
    const toolsRevived = lastRequestTools(llm);
    assert(toolsRevived.includes('plan') && !toolsRevived.includes('edit'), `bad cell revived pseudo-active whitelist (plan in, edit out), got ${toolsRevived.join(',')}`);

    const abortId = 'abort-clean';
    api2.send({ type: 'prompt', id: abortId, message: '/plan abort' });
    await api2.wait((f) => f.type === 'response' && f.id === abortId && f.success, 'abort ack');
    await sleep(500);
    const warn = notifyFrames(api2).filter((f) => f.message?.startsWith(NOTIFY_INACTIVE_WARN_PREFIX));
    assert(warn.length === 1 && warn[0].notifyType === 'warning', `cleanup abort warns inactive correction, got ${JSON.stringify(warn.map((w) => [w.message, w.notifyType]))}`);
    const entries = planEntriesOf(ws);
    const last = entries[entries.length - 1];
    assert(last.state === expectedCleanState && last.isActive === false, `cleanup entry ${expectedCleanState}+inactive, got ${JSON.stringify(last)}`);
    dumpScene(api2, `${sceneTag}-run2`);
  } finally {
    await stopPi(api2);
  }

  // 段3：二次重开不复活（工具集全量 + 零新落盘）
  const entryCountBefore = planEntriesOf(ws).length;
  const api3 = startPi(ws, llm, { sessionFile });
  try {
    await api3.rpcReady();
    await sleep(600);
    assert(!api3.frames.some((f) => f.type === 'extension_ui_request' && f.title === PLAN_REVIEW_MARKER), 'no review select after cleanup');
    llm.responses.push(() => ({ text: 'clean reopen' }));
    api3.send({ type: 'prompt', id: 'p-final', message: 'final check' });
    await api3.waitSettled();
    const tools = lastRequestTools(llm);
    assert(tools.includes('edit') && tools.includes('write'), `full tool set after cleanup, got ${tools.join(',')}`);
    assert(planEntriesOf(ws).length === entryCountBefore, `no new plan-state entry after cleanup reopen`);
    log(`PASS ${sceneTag} 坏格（${badState}+isActive=true）手写残留：重开复活（白名单收拢）→ abort 清洗落盘（${expectedCleanState}+isActive=false）→ 二次重开不复活、工具集恢复全量`);
  } finally {
    await stopPi(api3);
    llm.server.close();
    dumpScene(api3, `${sceneTag}-run3`);
    rmSync(ws.WORK, { recursive: true, force: true });
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────
function dumpScene(api, name) {
  try {
    const out = api.frames.map((f) => JSON.stringify(f)).join('\n');
    writeFileSync(join(ARTIFACTS, 'scenes', `${name}.log`), out || '(no frames)');
  } catch { /* diagnostics only */ }
}

async function main() {
  const results = [];
  const run = async (tag, fn) => {
    const started = Date.now();
    const lines = [];
    const log = (m) => lines.push(m);
    try {
      await fn(log);
      results.push({ tag, ok: true, ms: Date.now() - started, lines });
    } catch (e) {
      lines.push(`FAIL: ${e?.stack ?? e}`);
      results.push({ tag, ok: false, ms: Date.now() - started, lines });
    }
  };

  await run('①', scene1);
  if (process.env.A1A_ONLY) {
    // 调试通道：A1A_ONLY=1 只跑场景①
  } else {
    await run('②', scene2);
    await run('③', scene3);
    await run('⑤', scene5);
    await run('⑦', scene7);
    await run('⑧', scene8);
    await run('⑨a', (log) => badCellScene(log, '⑨a', 'completed', 'completed'));
    await run('⑨b', (log) => badCellScene(log, '⑨b', 'idle', 'exited'));
  }

  const failed = results.filter((r) => !r.ok);
  const md = [];
  md.push('## 八场景逐条结果');
  md.push('');
  for (const r of results) {
    md.push(`- **${r.ok ? 'PASS' : 'FAIL'} ${r.tag}**（${r.ms}ms）`);
    for (const l of r.lines) md.push(`  - ${l}`);
  }
  md.push('');
  md.push(`共 ${results.length} 场景，PASS ${results.length - failed.length}，FAIL ${failed.length}。`);
  writeFileSync(join(ARTIFACTS, 'scenarios.md'), `${md.join('\n')}\n`);

  // 供 bash 消耗的汇总行
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.tag} (${r.ms}ms)${r.ok ? '' : ` — ${r.lines[r.lines.length - 1]}`}`);
  }
  console.log(`SUMMARY ${results.length - failed.length}/${results.length}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
  // 显式退出：个别 http server / 子进程句柄可能滞留事件循环，验收结论已定不拖尾
  process.exit(process.exitCode);
}

// 总看门狗：任何场景挂死不拖垮整个剧本（macOS bash 无 timeout 命令兜底）
const WATCHDOG_MS = 420000;
const watchdog = setTimeout(() => {
  console.error(`WATCHDOG: script exceeded ${WATCHDOG_MS}ms, aborting`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref();

await main();
