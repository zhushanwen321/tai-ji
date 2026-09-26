#!/usr/bin/env node
/**
 * mock pi 自测入口（U0 验收条款①/③）——全零 token、零外部依赖、约 10s。
 *
 * 覆盖：
 *   marker-literal-drift  marker 字面量镜像与 extension-protocol 源文件比对（防漂移）
 *   basic-commands        命令应答族（ok / error envelope / get_messages data.messages）
 *   get-state             get_state 应答（create 链 fatal 字段集 + switch_session 后 sessionFile 回报；
 *                         字段集对齐 pi 实装 dist/modes/rpc/rpc-mode.js:347-362）
 *   plan-review-flow      prompt → agent_start → plan-state 落盘 → 审批 select 挂起
 *   select-delay-1500     select 登记延迟参数化（1.5s 形态可构造，S3 稳定窗靶向）
 *   abort-dissolve        abort 解散 + 现版 cancelled 形态不落盘（F1 机制面）
 *   crash-on-abort        杀进程/崩溃注入（SIGKILL 自杀可观测）
 *   abort-unanswered      abort 无应答（60s 阶梯前置构造）
 *   boundary-frames       空载荷 / 非法形态 / 超限 / error envelope 帧族逐项性质断言
 *   select-response-chain respond 后落盘改态 + 第二 select 挂起（F5 构造链）
 *   install-restore       文件级置换 install/restore 往返 + 三证恢复（假 bin 目录 + stub 真 pi）
 *   install-restore-bin-name  非 pi 文件名往返（--bin-name pi-darwin-arm64——runtime 解析
 *                         `resources/pi/pi-<platform>-<arch>` 的真实形态；回执 binName 回推 + 同目录兄弟文件不动）
 *
 * 运行：node scripts/acceptance/plan-mode/mock-pi/selftest.mjs
 * 退出码：0 = 全绿；1 = 任一用例红。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MOCK_PI = join(SCRIPT_DIR, 'mock-pi.mjs');
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..', '..');

let failed = 0;
const results = [];

function check(name, ok, evidence) {
  results.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${evidence}`);
  if (!ok) failed += 1;
}

function assert$ (name, cond, evidence) {
  check(name, Boolean(cond), evidence);
}

// ── mock 进程 harness ──────────────────────────────────────────────
class MockProc {
  constructor(configPath) {
    this.configPath = configPath;
    this.frames = [];
    this.waiters = [];
    this.stderr = '';
    this.exited = null;
    this.proc = spawn(process.execPath, [MOCK_PI, '--mode', 'rpc', '--model', 'stub/model', '--config', configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let f;
        try {
          f = JSON.parse(line);
        } catch {
          continue;
        }
        this.frames.push(f);
        this.waiters = this.waiters.filter((w) => !w(f));
      }
    });
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString(); });
    this.proc.on('exit', (code, signal) => { this.exited = { code, signal }; });
  }

  send(obj) {
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  waitFor(pred, timeoutMs = 4000, label = 'frame') {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout waiting ${label} (${timeoutMs}ms)`)), timeoutMs);
      const w = (f) => {
        if (pred(f)) {
          clearTimeout(timer);
          res(f);
          return true;
        }
        return false;
      };
      const existing = this.frames.find(pred);
      if (existing) {
        clearTimeout(timer);
        res(existing);
        return;
      }
      this.waiters.push(w);
    });
  }

  async waitExit(timeoutMs = 4000) {
    if (this.exited) return this.exited;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timeout waiting exit')), timeoutMs);
      this.proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        res({ code, signal });
      });
    });
  }

  noFrameWithin(pred, ms) {
    return new Promise((res) => {
      const start = this.frames.length;
      setTimeout(() => {
        res(!this.frames.slice(start).some(pred));
      }, ms);
    });
  }

  close() {
    try { this.proc.stdin.end(); } catch { /* already dead */ }
    try { this.proc.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

function writeConfig(dir, config) {
  const p = join(dir, 'active-config.json');
  writeFileSync(p, JSON.stringify(config));
  return p;
}

const isPlanReviewSelect = (f) => f.type === 'extension_ui_request' && f.method === 'select' && String(f.title).includes('TAIJI_PLAN_REVIEW');
const isUiFormSelect = (f) => f.type === 'extension_ui_request' && f.method === 'select' && String(f.title).includes('TAIJI_UI_FORM');

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'mock-pi-selftest-'));
  try {
    await caseMarkerDrift();
    await caseBasicCommands(work);
    await caseGetState(work);
    await casePlanReviewFlow(work);
    await caseSelectDelay(work);
    await caseAbortDissolve(work);
    await caseCrashOnAbort(work);
    await caseAbortUnanswered(work);
    await caseBoundaryFrames(work);
    await caseSelectResponseChain(work);
    await caseInstallRestore(work);
    await caseInstallRestoreBinName(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`\nmock-pi selftest: ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

// ── 用例 ───────────────────────────────────────────────────────────

async function caseMarkerDrift() {
  // 源文件用 \x00 转义、frames.mjs 用 \u0000 转义——按解码后的运行期字面值比对
  const framesMod = await import(new URL('./lib/frames.mjs', import.meta.url));
  const markerSrc = readFileSync(join(REPO_ROOT, 'packages/extension-protocol/src/core/markers.ts'), 'utf-8');
  const uiFormSrc = readFileSync(join(REPO_ROOT, 'packages/extension-protocol/src/extensions/ui-form/marker.ts'), 'utf-8');
  const decodeEsc = (s) => s.replace(/\\x00/g, '\u0000').replace(/\\u0000/g, '\u0000');
  const expectPlan = decodeEsc(markerSrc.match(/PLAN_REVIEW_MARKER = '([^']+)'/)?.[1] ?? '\x00');
  const expectForm = decodeEsc(uiFormSrc.match(/UI_FORM_MARKER = '([^']+)'/)?.[1] ?? '\x00');
  assert$('marker-literal-drift/plan-review', expectPlan.length > 1 && framesMod.PLAN_REVIEW_MARKER === expectPlan,
    `source ${JSON.stringify(expectPlan)} === frames.mjs ${JSON.stringify(framesMod.PLAN_REVIEW_MARKER)}`);
  assert$('marker-literal-drift/ui-form', expectForm.length > 1 && framesMod.UI_FORM_MARKER === expectForm,
    `source ${JSON.stringify(expectForm)} === frames.mjs ${JSON.stringify(framesMod.UI_FORM_MARKER)}`);
}

async function caseBasicCommands(work) {
  const mp = new MockProc(writeConfig(work, { scenario: 'plan-review-pending' }));
  try {
    mp.send({ id: 'c1', type: 'get_available_models' });
    const r1 = await mp.waitFor((f) => f.id === 'c1' && f.type === 'response');
    assert$('basic-commands/ok-response', r1.success === true && r1.command === 'get_available_models' && Array.isArray(r1.data?.models),
      `response ok, data.models=[]`);

    mp.send({ id: 'c2', type: 'totally_unknown_command' });
    const r2 = await mp.waitFor((f) => f.id === 'c2' && f.type === 'response');
    assert$('basic-commands/error-envelope', r2.success === false && typeof r2.error === 'string' && r2.error.includes('unhandled'),
      `error envelope: ${r2.error}`);

    mp.send({ id: 'c3', type: 'get_messages' });
    const r3 = await mp.waitFor((f) => f.id === 'c3' && f.type === 'response');
    assert$('basic-commands/get-messages', r3.success === true && Array.isArray(r3.data?.messages),
      'history in data.messages');

    mp.send({ id: 'c4', type: 'switch_session', sessionPath: join(work, 'session-a.jsonl') });
    const r4 = await mp.waitFor((f) => f.id === 'c4' && f.type === 'response');
    assert$('basic-commands/switch-session', r4.success === true, 'switch_session ack');
  } finally {
    mp.close();
  }
}

async function caseGetState(work) {
  // 窗口③阻塞根因回归：runtime create 链 readBackCreateState 恒经 get_state，
  // error envelope → sendCommand reject → safeDestroy + create 失败。
  const sessionPath = join(work, 'session-state.jsonl');
  const mp = new MockProc(writeConfig(work, { scenario: 'plan-review-pending', sessionPath }));
  try {
    mp.send({ id: 'g1', type: 'get_state' });
    const r1 = await mp.waitFor((f) => f.id === 'g1' && f.type === 'response');
    assert$('get-state/success-reply', r1.success === true && r1.command === 'get_state',
      `success reply, command=${r1.command}（create 链入口）`);
    assert$('get-state/session-id', typeof r1.data?.sessionId === 'string' && r1.data.sessionId.length > 0,
      `sessionId=${r1.data?.sessionId}（缺失 = readBackCreateState fatal）`);
    assert$('get-state/session-file', r1.data?.sessionFile === sessionPath,
      `sessionFile=${r1.data?.sessionFile}（config 预设路径，rpc-client/attach 断言 I1 消费）`);
    assert$('get-state/model-from-argv', r1.data?.model?.provider === 'stub' && r1.data?.model?.id === 'model',
      `model=${JSON.stringify(r1.data?.model)}（--model stub/model argv 解析）`);

    // 字段集对齐实装 rpc-mode.js:347-362（12 字段；model/sessionFile 已由上两条单独断言）
    const d = r1.data ?? {};
    const rest = ['thinkingLevel', 'isStreaming', 'isCompacting', 'steeringMode', 'followUpMode', 'sessionId', 'sessionName', 'autoCompactionEnabled', 'messageCount', 'pendingMessageCount'];
    const missing = rest.filter((k) => !(k in d));
    assert$('get-state/field-set', missing.length === 0 && typeof d.thinkingLevel === 'string' && typeof d.isStreaming === 'boolean' && typeof d.messageCount === 'number',
      `实装 12 字段齐备（messageCount=${d.messageCount}, thinkingLevel=${d.thinkingLevel}）`);

    // switch_session 后 get_state 回报新路径 + sessionId 稳定（attach 断言比对形态）
    const switched = join(work, 'session-switched.jsonl');
    mp.send({ id: 's1', type: 'switch_session', sessionPath: switched });
    await mp.waitFor((f) => f.id === 's1' && f.type === 'response');
    mp.send({ id: 'g2', type: 'get_state' });
    const r2 = await mp.waitFor((f) => f.id === 'g2' && f.type === 'response');
    assert$('get-state/after-switch', r2.success === true && r2.data?.sessionFile === switched && r2.data?.sessionId === r1.data?.sessionId,
      `switch 后 sessionFile=${r2.data?.sessionFile}，sessionId 稳定`);
  } finally {
    mp.close();
  }
}

async function casePlanReviewFlow(work) {
  const sessionPath = join(work, 'session-flow.jsonl');
  const mp = new MockProc(writeConfig(work, { scenario: 'plan-review-pending', sessionPath }));
  try {
    mp.send({ id: 's0', type: 'switch_session', sessionPath });
    await mp.waitFor((f) => f.id === 's0' && f.type === 'response');
    mp.send({ id: 'p1', type: 'prompt', message: '/plan 给设置页加主题切换' });
    await mp.waitFor((f) => f.type === 'agent_start');
    const sel = await mp.waitFor(isPlanReviewSelect, 4000, 'plan-review select');
    assert$('plan-review-flow/select-frame', sel.method === 'select' && sel.id === 'pr-fixture-1',
      `select id=${sel.id}`);
    const payload = JSON.parse(sel.options[0]);
    assert$('plan-review-flow/select-payload', Array.isArray(payload?.docs) && payload.docs.length === 1,
      `options[0] JSON docs=${payload.docs.length}`);
    const entries = readFileSync(sessionPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const last = entries.at(-1);
    assert$('plan-review-flow/entry-persist', last?.type === 'custom' && last?.customType === 'plan-state' && last?.data?.reviewState === 'awaiting',
      `session entry customType=plan-state reviewState=${last?.data?.reviewState}`);
  } finally {
    mp.close();
  }
}

async function caseSelectDelay(work) {
  // 验收条款③：select 登记延迟可参数化（1.5s 形态可构造）——config.params 覆盖通道
  const sessionPath = join(work, 'session-delay.jsonl');
  const mp = new MockProc(writeConfig(work, { scenario: 'plan-review-pending', sessionPath, params: { selectRegisterDelayMs: 1500 } }));
  try {
    mp.send({ id: 's0', type: 'switch_session', sessionPath });
    await mp.waitFor((f) => f.id === 's0' && f.type === 'response');
    const t0 = Date.now();
    mp.send({ id: 'p1', type: 'prompt', message: '重新提交审批' });
    await mp.waitFor((f) => f.id === 'p1' && f.type === 'response');
    await mp.waitFor(isPlanReviewSelect, 5000, 'delayed plan-review select');
    const tSelect = Date.now();
    const entries = readFileSync(sessionPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const gap = tSelect - t0;
    assert$('select-delay-1500/param', gap >= 1400 && gap <= 3000, `select 登记延迟实测 ${gap}ms（目标 1500ms，persist→pending 间隙构造可用）`);
    assert$('select-delay-1500/persist-before-select', entries.at(-1)?.data?.reviewState === 'awaiting',
      'plan-state 落盘先于 select 登记（persist→pending 间隙形态）');
  } finally {
    mp.close();
  }
}

async function caseAbortDissolve(work) {
  const sessionPath = join(work, 'session-abort.jsonl');
  const mp = new MockProc(writeConfig(work, { scenario: 'repro-dismiss-no-persist', sessionPath }));
  try {
    mp.send({ id: 's0', type: 'switch_session', sessionPath });
    await mp.waitFor((f) => f.id === 's0' && f.type === 'response');
    mp.send({ id: 'p1', type: 'prompt', message: '/plan x' });
    await mp.waitFor(isPlanReviewSelect);
    mp.send({ id: 'a1', type: 'abort' });
    const ack = await mp.waitFor((f) => f.id === 'a1' && f.type === 'response');
    assert$('abort-dissolve/ack', ack.success === true, 'abort 应答 ok');
    await mp.waitFor((f) => f.type === 'agent_end');
    const entries = readFileSync(sessionPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const last = entries.at(-1);
    assert$('abort-dissolve/no-entry-on-cancel', entries.length === 1 && last?.data?.reviewState === 'awaiting',
      `abort 后零新 entry，末条 reviewState 仍 ${last?.data?.reviewState}（现版 cancelled 分支不落盘 = F1 机制面）`);
  } finally {
    mp.close();
  }
}

async function caseCrashOnAbort(work) {
  const mp = new MockProc(writeConfig(work, { scenario: 'crash-on-abort' }));
  try {
    mp.send({ id: 'p1', type: 'prompt', message: '/plan x' });
    await mp.waitFor(isPlanReviewSelect);
    mp.send({ id: 'a1', type: 'abort' });
    const exit = await mp.waitExit(4000);
    assert$('crash-on-abort/exit', exit.signal === 'SIGKILL' || exit.code !== 0,
      `崩溃注入可观测: exit=${JSON.stringify(exit)}`);
  } finally {
    mp.close();
  }
}

async function caseAbortUnanswered(work) {
  const mp = new MockProc(writeConfig(work, { scenario: 'abort-unanswered' }));
  try {
    mp.send({ id: 'p1', type: 'prompt', message: '/plan x' });
    await mp.waitFor(isPlanReviewSelect);
    mp.send({ id: 'a1', type: 'abort' });
    const none = await mp.noFrameWithin((f) => f.id === 'a1' || f.type === 'agent_end', 500);
    assert$('abort-unanswered/no-response', none, 'abort 后 500ms 无应答无收轮（60s 超时阶梯前置构造）');
  } finally {
    mp.close();
  }
}

async function caseBoundaryFrames(work) {
  const mp = new MockProc(writeConfig(work, { scenario: 'boundary-frames' }));
  try {
    mp.send({ id: 'p1', type: 'prompt', message: '/plan x' });
    await mp.waitFor((f) => f.type === 'agent_end');

    const byTitle = (t) => mp.frames.find((f) => f.type === 'extension_ui_request' && f.title === t);
    const emptySel = byTitle('edge-empty-options');
    assert$('boundary/empty-payload-options', emptySel && Array.isArray(emptySel.options) && emptySel.options.length === 0,
      '空载荷：options: []');
    const blankSel = byTitle('edge-blank-option');
    assert$('boundary/empty-payload-blank', blankSel?.options?.[0] === '', '空载荷变体：options[0] = ""');

    const illegal = mp.frames.find((f) => f.type === 'extension_ui_request' && f.options?.[0] === '{not-json');
    let illegalThrows = false;
    try { JSON.parse(illegal.options[0]); } catch { illegalThrows = true; }
    assert$('boundary/illegal-json', illegalThrows, '非法形态：options[0] 不可解析');

    const safeParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
    const docsBad = mp.frames.filter(isPlanReviewSelect).map((f) => safeParse(f.options[0])).find((p) => p?.docs !== undefined && !Array.isArray(p.docs));
    assert$('boundary/docs-nonarray', Boolean(docsBad), '非法形态变体：marker 命中但 docs 非数组');

    const overSelect = mp.frames.filter(isPlanReviewSelect).map((f) => f.options[0]).find((s) => s.length > 4096);
    assert$('boundary/oversize-review', Boolean(overSelect), `超限：plan-review payload ${overSelect?.length ?? 0} bytes > 4KB 自审上限`);

    const overEntryFrame = mp.frames.find((f) => typeof f?.data?.requirement === 'string' && f.data.requirement.length > 65536);
    assert$('boundary/oversize-requirement', Boolean(overEntryFrame), `超限：plan-state requirement ${overEntryFrame?.data?.requirement.length ?? 0} chars > 64KB`);

    const overMsg = mp.frames.find((f) => f.type === 'message_end' && JSON.stringify(f).length > 200 * 1024);
    assert$('boundary/oversize-message', Boolean(overMsg), '超限：message_end > 200KB');

    const errEnv = mp.frames.find((f) => f.type === 'response' && f.success === false && typeof f.error === 'string');
    assert$('boundary/error-envelope', Boolean(errEnv), `error envelope 帧：${errEnv?.error ?? ''}`);
  } finally {
    mp.close();
  }
}

async function caseSelectResponseChain(work) {
  const sessionPath = join(work, 'session-chain.jsonl');
  const mp = new MockProc(writeConfig(work, { scenario: 'repro-exec-form-pending', sessionPath }));
  try {
    mp.send({ id: 's0', type: 'switch_session', sessionPath });
    await mp.waitFor((f) => f.id === 's0' && f.type === 'response');
    mp.send({ id: 'p1', type: 'prompt', message: '/plan x' });
    const sel1 = await mp.waitFor(isPlanReviewSelect);
    // 模拟 runtime extension_ui_response（approve 应答，sendRaw 形态无 type）
    mp.send({ id: sel1.id, value: JSON.stringify({ decision: 'approve' }) });
    const sel2 = await mp.waitFor(isUiFormSelect, 4000, 'exec form select');
    assert$('select-response-chain/second-select', sel2.id === 'uf-repro-f5',
      `respond 后第二 select 挂起: ${sel2.id}`);
    const questions = JSON.parse(sel2.options[0]);
    assert$('select-response-chain/form-payload', Array.isArray(questions.formQuestions) && questions.formQuestions[0].options.length === 3,
      `执行方式表单三档: ${questions.formQuestions[0].options.map((o) => o.value).join(' / ')}`);
    const entries = readFileSync(sessionPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const last = entries.at(-1);
    assert$('select-response-chain/cleared-review-state', entries.length === 2 && last?.data?.reviewState === undefined,
      'approve 后 entry 先清 reviewState 再挂表单（F5 构造链）');
  } finally {
    mp.close();
  }
}

async function caseInstallRestore(work) {
  // 假 bin 目录 + stub 真 pi（symlink 形态），不触碰真实 node_modules
  const binDir = join(work, 'bin');
  mkdirSync(binDir, { recursive: true });
  const stubPi = join(binDir, 'real-pi-stub.mjs');
  writeFileSync(stubPi, '#!/usr/bin/env node\nprocess.stdout.write("0.84.4-stub REAL_PI_STUB\\n");\n');
  chmodSync(stubPi, 0o755);
  symlinkSync('real-pi-stub.mjs', join(binDir, 'pi'));
  const configPath = join(work, 'mock-cfg', 'active-config.json');

  const inst = spawnSync(process.execPath, [join(SCRIPT_DIR, 'install-mock-pi.mjs'),
    '--bin-dir', binDir, '--config', configPath, '--scenario', 'plan-review-pending'], { encoding: 'utf-8' });
  assert$('install-restore/install', inst.status === 0 && existsSync(join(binDir, 'pi.bak')),
    `install exit=${inst.status}，原 symlink 移为 pi.bak`);
  const wrapVer = spawnSync(join(binDir, 'pi'), ['--version'], { encoding: 'utf-8' });
  assert$('install-restore/wrapper-active', wrapVer.stdout.includes('mock-pi'),
    `置换后 --version = ${JSON.stringify(wrapVer.stdout.trim())}`);
  assert$('install-restore/wrapper-uses-mock', lstatSync(join(binDir, 'pi')).isSymbolicLink() === false,
    'wrapper 为普通文件（文件级置换形态）');

  const rest = spawnSync(process.execPath, [join(SCRIPT_DIR, 'restore-mock-pi.mjs'),
    '--bin-dir', binDir, '--config', configPath], { encoding: 'utf-8' });
  const threeProofs = (rest.stdout.match(/证[①②③123] PASS/g) ?? []).length;
  assert$('install-restore/restore-3proofs', rest.status === 0 && /三证齐/.test(rest.stdout) && threeProofs === 3,
    `restore exit=${rest.status}，三证 PASS×${threeProofs}（symlink 还原 + --version 真实输出 + ls -l 形态）`);
  const realVer = spawnSync(join(binDir, 'pi'), ['--version'], { encoding: 'utf-8' });
  assert$('install-restore/real-restored', realVer.stdout.includes('REAL_PI_STUB') && lstatSync(join(binDir, 'pi')).isSymbolicLink(),
    `恢复后 --version = ${JSON.stringify(realVer.stdout.trim())} 且 symlink 形态还原`);
}

async function caseInstallRestoreBinName(work) {
  // B1 修复验证：非 pi 文件名往返（runtime 实际解析 apps/electron/resources/pi/pi-<platform>-<arch>）
  const binDir = join(work, 'bin-arch');
  mkdirSync(binDir, { recursive: true });
  const stubPi = join(binDir, 'real-pi-stub.mjs');
  writeFileSync(stubPi, '#!/usr/bin/env node\nprocess.stdout.write("0.84.4-stub REAL_PI_STUB\\n");\n');
  chmodSync(stubPi, 0o755);
  const archName = 'pi-darwin-arm64';
  symlinkSync('real-pi-stub.mjs', join(binDir, archName));
  symlinkSync('real-pi-stub.mjs', join(binDir, 'pi')); // 同目录兄弟文件——置换必须不碰
  const configPath = join(work, 'mock-cfg-arch', 'active-config.json');

  const inst = spawnSync(process.execPath, [join(SCRIPT_DIR, 'install-mock-pi.mjs'),
    '--bin-dir', binDir, '--bin-name', archName, '--config', configPath, '--scenario', 'plan-review-pending'], { encoding: 'utf-8' });
  assert$('install-restore-bin-name/install', inst.status === 0 && existsSync(join(binDir, `${archName}.bak`)) && !existsSync(join(binDir, 'pi.bak')),
    `install exit=${inst.status}，目标 = ${archName}（移为 ${archName}.bak），未误伤兄弟 pi`);
  const wrapVer = spawnSync(join(binDir, archName), ['--version'], { encoding: 'utf-8' });
  assert$('install-restore-bin-name/wrapper-active-sibling-untouched', wrapVer.stdout.includes('mock-pi')
    && lstatSync(join(binDir, archName)).isSymbolicLink() === false
    && lstatSync(join(binDir, 'pi')).isSymbolicLink() === true,
    `置换后 ${archName} --version = ${JSON.stringify(wrapVer.stdout.trim())}，兄弟 pi 仍为 symlink`);

  // restore 不传 --bin-name——按回执 binName 回推目标名（install/restore 对偶）
  const rest = spawnSync(process.execPath, [join(SCRIPT_DIR, 'restore-mock-pi.mjs'),
    '--bin-dir', binDir, '--config', configPath], { encoding: 'utf-8' });
  const threeProofs = (rest.stdout.match(/证[①②③123] PASS/g) ?? []).length;
  assert$('install-restore-bin-name/restore-3proofs-by-receipt', rest.status === 0 && /三证齐/.test(rest.stdout) && threeProofs === 3,
    `restore exit=${rest.status}（binName=${archName} 由回执回推），三证 PASS×${threeProofs}`);
  const realVer = spawnSync(join(binDir, archName), ['--version'], { encoding: 'utf-8' });
  assert$('install-restore-bin-name/real-restored', realVer.stdout.includes('REAL_PI_STUB') && lstatSync(join(binDir, archName)).isSymbolicLink(),
    `恢复后 ${archName} --version = ${JSON.stringify(realVer.stdout.trim())} 且 symlink 形态还原`);
}

main().catch((e) => {
  console.error('selftest runner error:', e);
  process.exit(1);
});
