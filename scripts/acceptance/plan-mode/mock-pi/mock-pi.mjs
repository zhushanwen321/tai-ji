#!/usr/bin/env node
/**
 * mock pi（taiji plan 模式验收脚本族）——真实 pi 的文件级置换替身。
 *
 * 形态（AGENTS.md「验收构造 mock pi = node_modules/.bin/pi 文件级置换」纪律）：
 * install-mock-pi.mjs 把本程序的 wrapper 写进 `node_modules/.bin/pi`（原 symlink 移为
 * `.bak`），runtime 的 find-pi-executable 解析链（resources/pi 缺失时 PATH →
 * node_modules/.bin/pi）命中新 spawn；窗口结束 restore-mock-pi.mjs 三证恢复。
 *
 * 协议面 = `packages/runtime/src/infra/pi/pi-protocol.ts`（JSONL over stdin/stdout）：
 * - 命令应答 `{id, type:'response', command, success, error?, data?}`；未知命令回 error envelope；
 * - `extension_ui_response` 不回 RPC reply（与真实 pi rpc-mode 一致）；
 * - 事件帧经 lib/frames.mjs 构造（含 error envelope 与边界帧族）；
 * - 场景剧本 = lib/scenario.mjs 的声明式 JSON（select 登记延迟参数化 / 杀进程 / 崩溃注入）。
 *
 * argv：容忍真实 pi 的全部 flag（--mode rpc / --model / --extension …，一律忽略+stderr 留痕）；
 * `--version` 输出 mock 版本；`--config <path>` 指定 active config（缺省见 scenario.mjs）。
 */
import { createInterface } from 'node:readline';

import * as frames from './lib/frames.mjs';
import { loadConfig, loadScenario } from './lib/scenario.mjs';
import { appendPlanStateEntry, appendRawEntry } from './lib/session-writer.mjs';

const MOCK_PI_VERSION = 'mock-pi 0.1.0 (taiji acceptance)';

// ── argv ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${MOCK_PI_VERSION}\n`);
  process.exit(0);
}
let configArg;
const ignoredFlags = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--config') {
    configArg = argv[i + 1];
    i += 1;
  } else {
    ignoredFlags.push(a);
  }
}

const { configPath, config } = loadConfig(configArg);
const { scenarioPath, scenario, params } = loadScenario(config);
log(`mock-pi start: scenario=${scenarioPath} config=${configPath}`);
log(`params: ${JSON.stringify(params)}`);
if (ignoredFlags.length) log(`ignored pi argv: ${ignoredFlags.join(' ')}`);

// ── 状态 ───────────────────────────────────────────────────────────
let sessionPath = typeof config.sessionPath === 'string' ? config.sessionPath : null;
let pendingSelectId = null;
let aborted = false;
const messageLog = []; // get_messages 历史（assistant/user 文本留痕）

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function log(msg) {
  process.stderr.write(`[mock-pi] ${msg}\n`);
}

function resolveRawFrames(list) {
  return (list ?? []).map((f) => {
    if (f && typeof f === 'object' && typeof f.__frame__ === 'string') {
      const builder = frames.BOUNDARY_FRAMES[f.__frame__];
      if (!builder) throw new Error(`mock-pi: unknown boundary frame: ${f.__frame__}`);
      return builder();
    }
    return f;
  });
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function crash(hint, how) {
  log(`crash injection: ${hint} ${JSON.stringify(how ?? {})}`);
  if (how?.signal) {
    process.kill(process.pid, how.signal);
    return;
  }
  process.exit(how?.code ?? 1);
}

// ── prompt 流（场景 onPrompt）────────────────────────────────────────
async function runPromptFlow(cmd) {
  const p = scenario.onPrompt ?? {};
  messageLog.push({ role: 'user', content: cmd.message });
  send(frames.responseOk(cmd.id, 'prompt'));
  send(frames.agentStart());
  for (const text of p.assistant ?? []) {
    send(frames.messageEnd('assistant', text));
    messageLog.push({ role: 'assistant', content: text });
  }
  // plan-state 落盘先于 select 登记（真实链路 persist→select 序；间隙 = selectRegisterDelayMs）
  if (p.planStateEntry) {
    if (sessionPath) {
      appendPlanStateEntry(sessionPath, p.planStateEntry);
      log('plan-state entry appended (pre-select)');
    } else {
      log('WARN: no sessionPath (switch_session 未到)，跳过 plan-state 落盘');
    }
  }
  await sleep(params.selectRegisterDelayMs);
  for (const f of resolveRawFrames(p.preSelectRawFrames)) send(f);
  if (p.select) {
    const frame = buildSelect(p.select);
    pendingSelectId = frame.id;
    send(frame);
    log(`select registered: ${frame.id} (delay ${params.selectRegisterDelayMs}ms)`);
  }
  for (const f of resolveRawFrames(p.rawFrames)) send(f);
  if (p.agentEnd) send(frames.agentEnd([], false));
  if (p.crash) crash('onPrompt.crash', p.crash);
}

function buildSelect(sel) {
  const kind = sel.kind ?? 'plan-review';
  if (kind === 'ui-form') {
    return frames.uiFormSelect({ ...sel, formQuestions: sel.formQuestions ?? frames.execFormQuestions({ skills: sel.skills ?? [] }) });
  }
  return frames.planReviewSelect(sel);
}

// ── select 应答（extension_ui_response，pi 不回 reply）────────────────
function handleUiResponse(line) {
  log(`extension_ui_response: ${JSON.stringify({ id: line.id, keys: Object.keys(line) })}`);
  if (pendingSelectId && line.id === pendingSelectId) pendingSelectId = null;
  const a = scenario.onSelectResponse ?? {};
  if (a.planStateEntry && sessionPath) {
    appendPlanStateEntry(sessionPath, a.planStateEntry);
    log('plan-state entry appended (onSelectResponse)');
  }
  for (const text of a.assistant ?? []) {
    send(frames.messageEnd('assistant', text));
    messageLog.push({ role: 'assistant', content: text });
  }
  for (const f of resolveRawFrames(a.rawFrames)) send(f);
  if (a.select) {
    const frame = buildSelect(a.select);
    pendingSelectId = frame.id;
    send(frame);
    log(`select registered (onSelectResponse): ${frame.id}`);
  }
  if (a.agentEnd) send(frames.agentEnd([], false));
  if (a.crash) crash('onSelectResponse.crash', a.crash);
}

// ── abort（解散源：turn abort / /plan abort 级联）─────────────────────
function handleAbort(cmd) {
  const a = scenario.onAbort ?? {};
  const mode = params.abortMode;
  log(`abort received: mode=${mode}`);
  if (mode === 'silent') {
    // 无应答形态 = runtime abort RPC 60s 超时阶梯的前置构造（F4②）
    return;
  }
  if (mode === 'crash') {
    crash('abortMode=crash', a.exit ?? { signal: 'SIGKILL' });
    return;
  }
  send(frames.responseOk(cmd.id, 'abort'));
  void (async () => {
    if (mode === 'delayed-dissolve') await sleep(params.abortDelayMs);
    if (aborted) return;
    aborted = true;
    // select 解散 = promise resolve undefined（P-1 语义：不向 runtime 发任何取消通知）
    pendingSelectId = null;
    if (a.planStateEntry && sessionPath) {
      appendPlanStateEntry(sessionPath, a.planStateEntry);
      log('plan-state entry appended (onAbort)');
    }
    for (const text of a.assistant ?? []) {
      send(frames.messageEnd('assistant', text));
      messageLog.push({ role: 'assistant', content: text });
    }
    for (const f of resolveRawFrames(a.rawFrames)) send(f);
    if (a.agentEnd ?? true) send(frames.agentEnd([], false));
    if (a.exit) crash('onAbort.exit', a.exit);
  })();
}

// ── 命令路由 ────────────────────────────────────────────────────────
function handleCommand(line) {
  if (line && typeof line === 'object' && (line.type === 'extension_ui_response' || (!line.type && 'id' in line && ('value' in line || 'confirmed' in line || 'cancelled' in line)))) {
    handleUiResponse(line);
    return;
  }
  const cmd = line?.type;
  switch (cmd) {
    case 'prompt':
      void runPromptFlow(line).catch((error) => {
        log(`prompt flow error: ${error?.stack ?? error}`);
        if (line?.id) send(frames.responseError(line.id, 'prompt', `mock-pi: prompt flow error: ${error?.message ?? error}`));
      });
      return;
    case 'abort':
      handleAbort(line);
      return;
    case 'switch_session':
      sessionPath = line.sessionPath ?? sessionPath;
      log(`switch_session: ${sessionPath}`);
      send(frames.responseOk(line.id, 'switch_session'));
      return;
    case 'new_session':
      send(frames.responseOk(line.id, 'new_session'));
      return;
    case 'set_model':
      send(frames.responseOk(line.id, 'set_model'));
      return;
    case 'get_available_models':
      send(frames.responseOk(line.id, 'get_available_models', { models: config.models ?? [] }));
      return;
    case 'get_messages':
      send(frames.responseOk(line.id, 'get_messages', { messages: messageLog }));
      return;
    default:
      // error envelope：未知/未实现命令（协议应答帧 error envelope 用例通路之一）
      log(`unhandled command: ${cmd ?? '<missing type>'}`);
      if (line?.id) send(frames.responseError(line.id, cmd ?? 'unknown', `mock-pi: unhandled command: ${cmd ?? '<missing type>'}`));
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const trimmed = raw.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    log(`illegal input line (skipped): ${trimmed.slice(0, 120)}`);
    return;
  }
  try {
    handleCommand(parsed);
  } catch (error) {
    log(`handler error: ${error?.stack ?? error}`);
    if (parsed?.id) send(frames.responseError(parsed.id, parsed.type ?? 'unknown', `mock-pi: handler error: ${error?.message ?? error}`));
  }
});
rl.on('close', () => {
  log('stdin closed, exit 0');
  process.exit(0);
});
