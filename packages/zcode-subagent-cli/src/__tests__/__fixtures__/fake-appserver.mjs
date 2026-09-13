/**
 * fake app-server（R2 连接层测试专用，绝不 spawn 真 zcode.cjs）。
 *
 * 移植改造自 zsw 仓 84b63a0^ z-subagent-workflow/fixtures/fake-appserver.js 的测试
 * 模式（该仓只读参照），vitest 子进程形态（ESM——本仓 eslint 禁 require，CJS 形态
 * 被 no-require-imports 拦截）：启动方式与真协议对齐——由被测 AppServerConnection
 * 以 `node <本文件> app-server --cwd <dir>` spawn（argv 解析后记录进流水，不消费）。
 * stdio NDJSON，帧形态对齐设计附录 A.1（无 jsonrpc 字段）。
 *
 * 测试断言面 = FAKE_STATE_FILE 事件流水（append JSONL）：
 *   boot / env / recv（收到的每个客户端帧）/ reverse-answer（反向请求收到的我方应答）
 * / unparseable-from-client。env 开关随 spawn env 固化：
 *   FAKE_STATE_FILE     流水文件路径（未设则不记流水）
 *   FAKE_STDERR=1       启动时往 stderr 写两行（tee 落盘断言取证）
 *   FAKE_EXTRA_KEYS=1   我方应答/推送帧携带未知键（客户端宽容解析断言）
 *   FAKE_PROTOCOL_PUSH=1 协议自报走 {method:'protocol'} 推送形态（缺省走 A.1 首帧
 *                        {protocol:{...}} 形态）
 *
 * 内置方法（可编程注入四帧型的全部形态）：
 *   test/echo            应答 {id, result: params}（原样回显——并发 id 关联断言依据）
 *   test/delay-echo      delayMs 后应答回显（制造在途请求）
 *   test/fail            应答 {id, error:{code,message,data}}（params 指定）
 *   test/push            先推一帧 {method: pushMethod, params: pushParams} 再应答
 *   test/reverse         发一个反向请求（method=params.reverseMethod）并等客户端
 *                        应答，流水记录后回 {id, result:{answered:true}}
 *   test/malformed-first 先写一行非 JSON 再正常应答（坏行跳过不断流断言）
 *   test/suicide         stderr 写 600 字符噪声 + 标记后 exit(1)（崩溃收割断言）
 *   session/create       真实协议语义（A.2）：先发反向请求 session/requestRuntime
 *                        Preferences 并等客户端应答（D9 常量表断言依据），流水记录
 *                        后回 {session:{sessionId}}
 *   session/subscribe    应答 {subscribed:true}（R3；真实应答形状未知——会话层不校验）
 *   session/send         按 FAKE_SESSION_SCENARIO 推送帧序列后应答（缺省 {accepted:true}）
 *   session/read         按 FAKE_SESSION_SCENARIO 应答（缺省 {messages:[]}）
 *   session/resume       按 FAKE_SESSION_SCENARIO 应答（缺省 {messages:[]}；resumeError
 *                        注入 error 帧）——[U6] resume 读通道（应答自带合成历史）
 *   session/close        应答 {closed:true}
 *   其余方法             应答 -32601（method not found）
 *
 * 会话场景注入（R3 会话层测试；不设 = 各方法走缺省行为，R2 连接层测试不受影响）：
 *   FAKE_SESSION_SCENARIO=<path> 启动时读取一次的 JSON 文件：
 *   {
 *     createResult?: object            覆盖 create 应答（golden create 应答注入）
 *     createError?: {code,message,data} create 应答 error 帧（-32602/-32601 注入）
 *     sendError?:   {code,message,data} send 应答 error 帧（-32010/-32602 注入）
 *     sendDenySessionIds?: [sessionId, ...]
 *                                      [U6] 对列出的 sessionId，session/send 应答
 *                                      -32031（ZCODE_RUNTIME_MODEL_UNAVAILABLE——
 *                                      P-1 实测「resume 后原会话 send 卡死」形态）：
 *                                      断言续聊链永不向旧会话 send（不回退路径）
 *     resumeResult?: object            [U6] 覆盖 session/resume 应答（合成历史注入）
 *     resumeError?: {code,message,data} [U6] resume 应答 error 帧（-32602/条目失效）
 *     sendResult?:  object             缺省 {accepted:true}
 *     crashAfterSendMs?: number        [P0-1 U4] send 应答后 N ms 自杀 exit(1)（连接
 *                                      崩溃收割注入——onClose → failAllTurns 在途
 *                                      turn 收割；进程死 → 下次 request 惰性重建
 *                                      boot 新代重读 scenario，重试轮/下一任务形态
 *                                      切换经测试侧 rewriteScenario）
 *     rebootSendPushes?: [frame, ...]  [P0-1 U4] 非首代进程（本 fake 启动时 state 流水
 *                                      已有 boot 记录——崩溃/杀链后的重建代）的 send
 *                                      推送序列，替代 sendPushes：崩溃后惰性重建的
 *                                      重试轮拿到不同行为（如完整终态流）——首轮挂起
 *                                      + 重试轮成功的静态注入通道（同任务重试轮无法
 *                                      经测试侧 rewriteScenario 插手，run 整体 await）
 *     readError?:   {code,message,data} read 应答 error 帧（read 兜底降级链断言）
 *     readResult?:  object             覆盖 read 应答
 *     stopBehavior?: 'terminal'|'none'|'hang'
 *                                      session/stop 的行为（R4 abort 链断言面）：
 *                                      'terminal'（缺省）= stop 时推送该会话的
 *                                      turn.terminal 终态帧（stop 优雅生效——不杀
 *                                      进程的 abort 路径）；'none' = 只应答不推终态
 *                                      （grace 窗口耗尽 → killChain 兜底路径）；
 *                                      'hang' = 连应答都不给（P0-1 U2 超时入口态③——
 *                                      控制面假死注入，stop 3s 超时 → 连接级失败判据）
 *     stopError?:   {code,message,data} stop 应答 error 帧（P0-1 U2 超时入口态②——
 *                                      协议性 error（如会话已回收）注入，断言不升级杀链）
 *   }
 *
 * 多会话支持（R4 引擎接线 / RA3 双会话地基）：
 *   FAKE_STAMP_SESSION=1   session/send 的推送帧回放时把 params.sessionId 统一改写
 *                          为「当前 send 的目标会话」，telemetry 帧（无 sid）补记
 *                          sessionId——并发两会话各自收到归因正确的推送流，不串线。
 *                          （缺省关：R2/R3 单会话用例的字节级行为不变。）
 *   session/stop           应答 {stopped:true}；按 scenario.stopBehavior 决定是否
 *                          推送终态帧（见上）。stopTerminal 推送同样受 STAMP 改写。
 */
import fs from 'node:fs';
import readline from 'node:readline';

const STATE_FILE = process.env.FAKE_STATE_FILE;
const EXTRA_KEYS = process.env.FAKE_EXTRA_KEYS === '1';
const PROTOCOL_AS_PUSH = process.env.FAKE_PROTOCOL_PUSH === '1';
// [R4] 多会话推送改写开关（见文件头注释）
const STAMP_SESSION = process.env.FAKE_STAMP_SESSION === '1';

// 会话场景（R3）：启动时读取一次（env 固化语义与其他 FAKE_ 开关一致）
let SCENARIO = null;
if (process.env.FAKE_SESSION_SCENARIO) {
  try {
    SCENARIO = JSON.parse(fs.readFileSync(process.env.FAKE_SESSION_SCENARIO, 'utf8'));
  } catch (err) {
    log('scenario-load-failed', { message: String(err && err.message) });
  }
}

// [P0-1 U4] 本进程代数（state 流水已有 boot 记录数 + 1）：崩溃/杀链后的惰性重建代
// ≥2——rebootSendPushes 仅对重建代生效（重试轮拿到与首轮不同的推送序列）
let BOOT_GEN = 1;
if (STATE_FILE && SCENARIO && SCENARIO.rebootSendPushes) {
  try {
    const priorBoots = fs
      .readFileSync(STATE_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.includes('"ev":"boot"')).length;
    BOOT_GEN = priorBoots + 1;
  } catch { /* 流水读失败按首代处理 */ }
}

let seq = 0;
function log(ev, data = {}) {
  if (!STATE_FILE) return;
  try {
    fs.appendFileSync(STATE_FILE, JSON.stringify({ seq: ++seq, ev, ...data }) + '\n');
  } catch { /* 流水写失败不影响协议行为 */ }
}

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const withExtra = (frame) => (EXTRA_KEYS ? { ...frame, unknownServerKey: 'lenient' } : frame);
const reply = (id, result) => out(withExtra({ id, result }));
const replyErr = (id, code, message, data) =>
  out({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

// 协议自报（A.1：首帧 {protocol:{...}}；推送形态显式开关——两种到达形态都要被忽略）
if (PROTOCOL_AS_PUSH) out({ method: 'protocol', params: { name: 'ZCode Protocol', version: 1 } });
else out({ protocol: { name: 'ZCode Protocol', version: 1 } });

// SIGTERM 优雅窗口：默认终止会丢弃「已写入管道但尚未读到」的帧——延迟退出让
// stdin 排空后收尾（dispose 的 close-帧-先于-SIGTERM 顺序在本侧可观测：
// killChain 的 grace 远大于本窗口，不会升级 SIGKILL）
process.on('SIGTERM', () => {
  setTimeout(() => process.exit(0), 100);
});

// env 快照 + boot 流水（惰性启动 / argv 形态 / env 惯例断言的数据源）。sessionDb
// 两键为 2026-09 会话库隔离的探针④数据源（env 不随 RPC 帧传输，只能在此快照）。
log('env', {
  pid: process.pid,
  home: process.env.HOME,
  telemetry: process.env.ZCODE_MODEL_TELEMETRY_ENABLED,
  nested: process.env.ZSW_NESTED,
  unifiedNested: process.env.XYZ_AGENT_SUBAGENT,
  sessionDbPath: process.env.ZCODE_SESSION_DB_PATH,
  sessionDbAlias: process.env.ZCODE_SESSION_DB,
});
log('boot', { pid: process.pid, argv: process.argv.slice(2) });
if (process.env.FAKE_STDERR === '1') {
  process.stderr.write('fake-appserver stderr line A\nfake-appserver stderr line B\n');
}

// 反向请求记账：id -> 客户端应答到达时 resolve
let reqSeq = 0;
const pendingReverse = new Map();

function sendReverse(method, params) {
  return new Promise((resolve) => {
    const id = `srv-${++reqSeq}`;
    pendingReverse.set(id, resolve);
    out({ id, method, ...(params !== undefined ? { params } : {}) });
  });
}

function onClientAnswer(frame) {
  const settle = pendingReverse.get(frame.id);
  if (settle) {
    pendingReverse.delete(frame.id);
    settle({ id: frame.id, result: frame.result, error: frame.error });
  }
}

// 推送帧回放（scenario 帧即 golden 语料/注入形态本身，不走 withExtra）。STAMP_SESSION
// 开启时统一改写/补记 params.sessionId 为目标会话（RA3 双会话地基：并发两会话各自
// 收到归因正确的推送流——真服务端推送本就按会话归因，telemetry 帧不带 sid 属协议
// 实测形态，stamp 是 fake 侧的确定性等价物）。
function pushFrames(frames, targetSessionId) {
  for (const frame of frames || []) {
    if (!STAMP_SESSION || !targetSessionId) {
      out(frame);
      continue;
    }
    const stamped = JSON.parse(JSON.stringify(frame));
    if (stamped && typeof stamped.params === 'object' && stamped.params !== null) {
      stamped.params.sessionId = targetSessionId;
    }
    out(stamped);
  }
}

// [R4] stop 触发的终态推送（stopBehavior 缺省 'terminal'——abort 优雅生效路径）
const TURN_TERMINAL_FRAME = {
  method: 'v4/telemetry/event',
  params: { kind: 'turn.terminal', status: 'success' },
};

async function handleRequest(f) {
  const { id, method } = f;
  const params = f.params ?? {};
  switch (method) {
    case 'test/echo':
      return reply(id, params);
    case 'test/delay-echo': {
      const delay = Number(params.delayMs) || 50;
      setTimeout(() => reply(id, params), delay);
      return;
    }
    case 'test/fail':
      return replyErr(id, Number(params.code) || -32603, String(params.message || 'fake failure'), params.data);
    case 'test/push': {
      const pushMethod = String(params.pushMethod || 'test/notification');
      out(withExtra({ method: pushMethod, ...(params.pushParams !== undefined ? { params: params.pushParams } : {}) }));
      return reply(id, { pushed: true });
    }
    case 'test/reverse': {
      const answer = await sendReverse(String(params.reverseMethod || 'permission/request'), params.reverseParams);
      log('reverse-answer', { requested: params.reverseMethod, answer });
      return reply(id, { answered: true });
    }
    case 'test/malformed-first':
      process.stdout.write('this is not json {{{\n');
      return reply(id, { survived: true });
    case 'test/suicide':
      process.stderr.write('A'.repeat(600) + 'CRASH-MARK-TAIL');
      process.exit(1);
      return; // 不可达（exit 先行），保持 switch 完整
    case 'session/create': {
      if (SCENARIO && SCENARIO.createError) {
        return replyErr(id, SCENARIO.createError.code, SCENARIO.createError.message, SCENARIO.createError.data);
      }
      const answer = await sendReverse('session/requestRuntimePreferences');
      log('reverse-answer', { requested: 'session/requestRuntimePreferences', answer });
      if (SCENARIO && SCENARIO.createResult) return reply(id, SCENARIO.createResult);
      return reply(id, { session: { sessionId: `sess_${id}` } });
    }
    case 'session/subscribe':
      return reply(id, (SCENARIO && SCENARIO.subscribeResult) || { subscribed: true });
    case 'session/send': {
      if (SCENARIO && SCENARIO.sendError) {
        return replyErr(id, SCENARIO.sendError.code, SCENARIO.sendError.message, SCENARIO.sendError.data);
      }
      // [U6] 定向拒投（-32031：P-1 实测「resume 后原会话 send 被
      // ZCODE_RUNTIME_MODEL_UNAVAILABLE 卡死」形态）——对指定旧会话 send 一律报错，
      // 断言续聊链只向新会话 send（原地 resume 不回退）。
      if (SCENARIO && Array.isArray(SCENARIO.sendDenySessionIds) && SCENARIO.sendDenySessionIds.includes(String(params.sessionId || ''))) {
        return replyErr(id, -32031, `ZCODE_RUNTIME_MODEL_UNAVAILABLE: model used by session ${params.sessionId} is no longer available (restoreWarning pending)`);
      }
      // 推送帧逐字回放（STAMP_SESSION 时按目标会话归因改写）；重建代走 rebootSendPushes
      // （U4：重试轮的不同行为通道）
      const pushes =
        BOOT_GEN > 1 && SCENARIO && SCENARIO.rebootSendPushes
          ? SCENARIO.rebootSendPushes
          : SCENARIO && SCENARIO.sendPushes;
      pushFrames(pushes, String(params.sessionId || ''));
      // [P0-1 U4] 崩溃收割注入：应答后 N ms 自杀（onClose → failAllTurns 在途 turn
      // 收割的确定性触发面；exit(1) 非零码与 test/suicide 同形态）
      const crashAfterSendMs = SCENARIO && SCENARIO.crashAfterSendMs;
      if (typeof crashAfterSendMs === 'number' && crashAfterSendMs >= 0) {
        setTimeout(() => {
          log('crash-injected', { afterMs: crashAfterSendMs });
          process.exit(1);
        }, crashAfterSendMs).unref();
      }
      return reply(id, (SCENARIO && SCENARIO.sendResult) || { accepted: true });
    }
    case 'session/stop': {
      // [R4] abort 链断言面：缺省推终态（stop 优雅生效）；stopBehavior:'none' 只应答；
      // stopError 注入协议性 error 应答帧（P0-1 U2 态②——不升级杀链判据）；
      // stopBehavior:'hang' 永不应答（态③——stop 3s 超时 = 连接级失败判据）
      const behavior = (SCENARIO && SCENARIO.stopBehavior) || 'terminal';
      if (behavior === 'hang') return;
      if (SCENARIO && SCENARIO.stopError) {
        return replyErr(id, SCENARIO.stopError.code, SCENARIO.stopError.message, SCENARIO.stopError.data);
      }
      if (behavior === 'terminal') {
        pushFrames([TURN_TERMINAL_FRAME], String(params.sessionId || ''));
      }
      return reply(id, { stopped: true });
    }
    case 'session/read': {
      if (SCENARIO && SCENARIO.readError) {
        return replyErr(id, SCENARIO.readError.code, SCENARIO.readError.message, SCENARIO.readError.data);
      }
      return reply(id, (SCENARIO && SCENARIO.readResult) || { messages: [] });
    }
    case 'session/resume': {
      // [U6] resume 读通道：应答自带合成历史（messages[].info.role + parts[].text，
      // 形态对齐 P-1 真机实测）；resumeError 注入 error 帧（条目被清/失效形态）。
      if (SCENARIO && SCENARIO.resumeError) {
        return replyErr(id, SCENARIO.resumeError.code, SCENARIO.resumeError.message, SCENARIO.resumeError.data);
      }
      return reply(id, (SCENARIO && SCENARIO.resumeResult) || { messages: [] });
    }
    case 'session/close':
      return reply(id, { closed: true });
    default:
      return replyErr(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = String(line).trim();
  if (!text) return;
  let f;
  try {
    f = JSON.parse(text);
  } catch {
    log('unparseable-from-client', { line: text.slice(0, 100) });
    return;
  }
  log('recv', { frame: f });
  if (f && f.id != null && typeof f.method === 'string') {
    void handleRequest(f);
    return;
  }
  if (f && f.id != null) onClientAnswer(f); // 我方反向请求的客户端应答
});
rl.on('close', () => process.exit(0));
