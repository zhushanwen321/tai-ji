#!/usr/bin/env node
/**
 * subagent relay 代理 CLI。
 *
 * 角色：双面字节泵——extension 眼中的 pi 子进程（stdio 与 spawn 真实 pi 字节级同构：
 * 逐行 JSONL RPC / get_state 握手由 extension 侧 session-runner 原样驱动，代理只搬运字节）
 * × runtime 眼中的 relay 客户端（本地 socket，先握手后转发）。协议不假设 stdio 是文本
 * 通道，payload 一律 base64 封装保字节精确。
 *
 * ============================ 显式状态机（M1，设计 §3.4.1 D1） ============================
 *
 *   connecting ──connect──▶ handshaking ──写 handshake──▶ awaiting_accept
 *   （失败重试一次）                                          │ accept           │ timeout / reject / close / signal
 *                                                            ▼                  ▼
 *                                                         pumping ──exit/close──▶ closing
 *                                                            ▲
 *                                                            │ drain（仅 pumping 才 resume stdin）
 *
 * 转移约束（事故根因修复，缺一即回归）：
 * - stdin 的 data 监听器只在 startPump() 内挂载；startPump() 只允许从 awaiting_accept
 *   转移进入（入口状态守卫）。事故形态：socket drain 早于 accept 把无监听的 stdin
 *   resume 成 flowing → 已写入管道的 prompt 被读出即丢弃（设计 §2.3）；
 * - startPump() 内部顺序固定：挂监听器 → 置 pumping → resume——resume 后读出的字节
 *   必然有监听器接住；
 * - socket 的 drain 处理器读当前状态，仅 pumping 才 resume stdin；
 * - awaiting_accept 的计时从进入该状态起算：超时 → closing + 退出码 15 + stderr 恢复
 *   指引；accept 先到则停表；进入 closing 后迟到的 accept/reject/数据帧一律忽略
 *   （终态幂等，不再转移）；
 * - awaiting_accept 期间到达的 data 帧不判死：缓冲至 pumping 后按泵期语义回放
 *   （「accept 前预写不丢」；runtime 当前形态 accept 先于 up 帧写出，此处是协议
 *   容错防御而非正常路径依赖）；
 * - 任何状态收 SIGTERM/SIGINT → closing：已 accept（pumping）发 goodbye 预告帧，
 *   未 accept 不发；按 128+signo 退出；
 * - closing 后所有操作幂等；process.exit 前 flush stderr/stdout 的既有逻辑保留。
 *
 * ============================ 镜像常量表 ============================
 * SSOT = packages/subagent-engine-sdk/src/relay-env.ts（零依赖脚本不能 import workspace 包，只能内嵌镜像；
 * core 侧经 subagent-core 的 ./relay-env 子入口 re-export 保 semver 面。改名/改值必须双侧同步，
 * 一致性由 E-3 conformance relay 变体断言锁定——设计 §10-5）：
 *
 *   | relay-env.ts 常量         | 本文件常量                | 值                          |
 *   |---------------------------|---------------------------|-----------------------------|
 *   | RELAY_ENV_SOCKET          | RELAY_ENV_SOCKET          | 'TAIJI_SUBAGENT_RELAY_SOCKET' |
 *   | RELAY_ENV_SESSION_ID      | RELAY_ENV_SESSION_ID      | 'TAIJI_SUBAGENT_RELAY_SESSION_ID' |
 *   | RELAY_ENV_RECORD_ID       | RELAY_ENV_RECORD_ID       | 'TAIJI_SUBAGENT_RELAY_RECORD_ID' |
 *   | RELAY_PROTOCOL_VERSION    | RELAY_PROTOCOL_VERSION    | 1                           |
 *   | RELAY_EXIT_CODES.*        | RELAY_EXIT_CODES.*        | 10/11/12/13/15              |
 *
 * 不镜像：RELAY_ENV_NODE / RELAY_ENV_SCRIPT 由 runtime（注入）与 extension（激活判定 +
 * spawn 组装）消费，代理零消费（不解析自身执行器路径）——镜像无消费方只会积累
 * unused 代码；激活契约的锁定由 pi-invocation 侧测试与 conformance relay 变体承担。
 *
 * ============================ 协议摘要（§3.1） ============================
 * - 握手：连接后第一帧（单行 JSONL，代理 → runtime）
 *   {"v":1,"kind":"handshake","mainSessionId":...,"recordId":...,"argv":[...],"env":{...},"cwd":...}
 * - runtime 回 {"v":1,"kind":"accept"}（进入泵模式）或
 *   {"kind":"reject","reason":"version","supported":[1]}（→ 退出码 10）
 * - 数据帧 {"v":1,"kind":"data","dir":...,"b64":...}：
 *   dir="down"（代理 stdin → runtime → 真实 pi stdin）/ "up"（→ 代理 stdout）/
 *   "up-stderr"（→ 代理 stderr）。方向以「数据流向真实 pi」为参照：下行 = 流向 pi。
 * - 退出帧 {"kind":"exit","code":C,"signal":S} → 代理以相同 code/signal 退出
 * - goodbye 帧 {"v":1,"kind":"goodbye"}（代理 → runtime，收到宿主 SIGTERM/SIGINT 时）：
 *   正常收割预告——runtime 据此把后续 socket close 判定为正常 teardown（kill 行为不变，
 *   仅日志分级），无预告的 close 保持异常断连语义（kill-on-disconnect warn）
 * - socket 断（close/error/EOF）→ 退出码 12：socket 是代理的生命线，断 = runtime
 *   崩溃等场景下 extension 侧感知「子进程死亡」的机制（崩溃矩阵②），不自杀会变孤儿。
 * - awaiting_accept 超时（TAIJI_RELAY_ACCEPT_TIMEOUT_MS 可覆盖，默认 10s）→ 退出码 15：
 *   accept 回执窗口的显式失败（控制面时间窗，非任务级墙钟）；引擎侧映射
 *   engine_spawn_handshake_timeout。
 *
 * ============================ 零依赖约束 ============================
 * 禁 import 任何非 node-builtin 模块：本脚本被 ELECTRON_RUN_AS_NODE（打包版 Electron
 * 内嵌 node）或 dev node 独立执行，无 node_modules 解析保障（设计 §3.2 形态 B）。
 * 同理不读配置文件、不写文件系统（pid 文件归 runtime 侧注册表）。
 */

import net from "node:net";
import os from "node:os";

// ---- 镜像常量（与 relay-env.ts 逐字一致，见头部对照表）----
const RELAY_ENV_SOCKET = "TAIJI_SUBAGENT_RELAY_SOCKET";
const RELAY_ENV_SESSION_ID = "TAIJI_SUBAGENT_RELAY_SESSION_ID";
const RELAY_ENV_RECORD_ID = "TAIJI_SUBAGENT_RELAY_RECORD_ID";

const RELAY_PROTOCOL_VERSION = 1;

const RELAY_EXIT_CODES = {
  VERSION_MISMATCH: 10,
  SOCKET_UNREACHABLE: 11,
  SOCKET_CLOSED: 12,
  MISSING_IDENTITY: 13,
  ACCEPT_TIMEOUT: 15,
};

// ---- 显式状态机（状态名与设计 §3.4.1 状态图逐字对应）----
const STATE = {
  /** 连接中（含一次失败重试窗口）；connect 事件前 socket error/close 都归此状态处理。 */
  CONNECTING: "connecting",
  /** 握手帧写出中：onConnected 内的同步瞬态（写出后立即转入 awaiting_accept），帧回调实际不会落在本状态。 */
  HANDSHAKING: "handshaking",
  /** 已发握手，等待 accept/reject；accept 回执计时窗（超时 → 15）；早到 data 帧缓冲。 */
  AWAITING_ACCEPT: "awaiting_accept",
  /** 双向字节泵运行中；唯一允许 resume stdin 的状态。 */
  PUMPING: "pumping",
  /** 终态：所有操作幂等，迟到帧一律忽略，flush 后退出。 */
  CLOSING: "closing",
};

/** 当前状态（唯一状态变量——原 handshakeAccepted/exiting 双布尔隐式时序的显式化）。 */
let state = STATE.CONNECTING;
/** 当前 socket 连接（connect 成功后赋值；重试期间为 null）。 */
let sock = null;
/** socket 按行解析的残留缓冲（JSONL 帧）。 */
let lineBuf = "";
/** awaiting_accept 的 accept 回执计时器（accept 先到或任何 closing 转移时清除）。 */
let acceptTimer = null;
/** awaiting_accept 期间缓冲的早到 data 帧（pumping 后按泵期语义回放）。 */
let preAcceptDataFrames = [];
/** 早到 data 帧缓冲字节数（配合上限防异常 runtime 撑爆内存）。 */
let preAcceptDataBytes = 0;
/** 早到 data 帧缓冲上限：accept 窗口（默认 10s）内正常形态不会有帧到达，超限 = 协议违例。 */
const PRE_ACCEPT_DATA_BUFFER_LIMIT = 32 * 1024 * 1024;
/** 当前 socket 路径（accept 超时的 stderr 恢复指引须含路径，设计 §3.5）。 */
let socketPath = null;

/** 首次连接失败到重试的间隔（毫秒）。设计未定值；取短值——只需覆盖 runtime 建 socket 与主 pi spawn 的毫秒级窗口。
 * RELAY_CONNECT_RETRY_DELAY_MS 仅测试注入通道（集成测试注入短值压缩重试等待）；NaN/非正数退回默认（负值会让 setTimeout 立即触发 busy retry）。 */
const _retryDelayEnv = Number(process.env.RELAY_CONNECT_RETRY_DELAY_MS);
const CONNECT_RETRY_DELAY_MS = Number.isFinite(_retryDelayEnv) && _retryDelayEnv > 0 ? _retryDelayEnv : 200;
/** awaiting_accept 的 accept 回执窗口（毫秒），TAIJI_RELAY_ACCEPT_TIMEOUT_MS 可覆盖。
 * 控制面握手回执窗口的显式失败通道（时间窗根因登记见设计 D1：accept 回执窗口非补偿
 * 掩盖；M3 删除 relay 时随 relay 一并消亡）。NaN/非正数退回默认（与重试间隔同款防御）。 */
const _acceptTimeoutEnv = Number(process.env.TAIJI_RELAY_ACCEPT_TIMEOUT_MS);
const ACCEPT_TIMEOUT_MS = Number.isFinite(_acceptTimeoutEnv) && _acceptTimeoutEnv > 0 ? _acceptTimeoutEnv : 10_000;
/** 退出前等待 stderr/stdout flush 的兜底上限（毫秒）：pipe 写是异步的，process.exit 会丢未 flush 数据。 */
const FLUSH_TIMEOUT_MS = 1000;
/** goodbye 帧写出后等待 flush 的兜底上限（毫秒）：runtime 已死等形态下 write 回调永不到达。 */
const GOODBYE_FLUSH_TIMEOUT_MS = 500;

const stdin = process.stdin;
const stdout = process.stdout;
const stderr = process.stderr;

// 崩溃矩阵③（代理自身异常死）的兜底：任何未捕获异常也走 12 语义退出 + stderr 留诊断，
// 保证 extension 侧看到确定的非零退出而非挂死。必须在 main() 调用前注册——main 同步
// 执行期（模块加载阶段）的异常不会触发「之后」才注册的 handler，会直接以裸 code 1 崩溃。
process.on("uncaughtException", (err) => {
  fail(
    RELAY_EXIT_CODES.SOCKET_CLOSED,
    `uncaught exception: ${err instanceof Error ? err.stack : String(err)}`,
  );
});

// 宿主终止预告（goodbye 帧）：宿主（extension/引擎）收割代理发 SIGTERM/SIGINT——
// 这通常发生在 agent_settled 后的正常收割，与宿主崩溃在 runtime 侧同表现为 socket
// close。被终止前先向 runtime 发 goodbye 预告帧，runtime 据此把 close 判定为正常
// teardown（info 级日志），异常断连才保留 warn 级 kill-on-disconnect。注册 handler 后
// Node 不再执行信号默认终止，发帧（含 flush 等待）后自行按 128+signo 退出，对宿主侧
// 的退出码口径（spawn close 折算 143）保持一致。
process.on("SIGTERM", () => hostTerminate("SIGTERM"));
process.on("SIGINT", () => hostTerminate("SIGINT"));

/**
 * 宿主信号终止：任何状态 → closing。已 accept（pumping）best-effort 发 goodbye →
 * 等 flush（有界）→ 按 128+signo 退出；未 accept（connecting/handshaking/
 * awaiting_accept）不发预告直接退出。
 */
function hostTerminate(sig) {
  if (state === STATE.CLOSING) return;
  const accepted = state === STATE.PUMPING;
  enterClosing();
  const signum = os.constants.signals[sig];
  const exitCode = 128 + (typeof signum === "number" ? signum : 0);
  const die = () => process.exit(exitCode);
  try {
    if (accepted && sock !== null && !sock.destroyed) {
      // write 回调 = 帧已离开写缓冲；兜底超时防 runtime 已死时回调永不到达。
      const timer = setTimeout(die, GOODBYE_FLUSH_TIMEOUT_MS);
      timer.unref();
      sock.write(
        JSON.stringify({ v: RELAY_PROTOCOL_VERSION, kind: "goodbye" }) + "\n",
        () => {
          clearTimeout(timer);
          die();
        },
      );
      return;
    }
  } catch {
    // socket 已坏（runtime 先死等形态）：无预告通道，直接按信号口径退出
  }
  die();
}

/** 进入 closing（终态）：首次进入执行退出前清理（停 accept 计时器），重复调用幂等。 */
function enterClosing() {
  if (state === STATE.CLOSING) return false;
  state = STATE.CLOSING;
  stopAcceptTimer();
  return true;
}

main();

function main() {
  // 启动自检（独立防御）：激活三 env 由 extension 的 isRelayActive 保证（全有或全无），
  // 归属两 env 由 buildChildEnv 注入——代理不信任上游，缺失即拒绝启动，防无归属帧污染广播。
  const missing = [];
  if (!process.env[RELAY_ENV_SESSION_ID]) missing.push(RELAY_ENV_SESSION_ID);
  if (!process.env[RELAY_ENV_RECORD_ID]) missing.push(RELAY_ENV_RECORD_ID);
  if (missing.length > 0) {
    fail(
      RELAY_EXIT_CODES.MISSING_IDENTITY,
      `identity env missing: ${missing.join(", ")}（应由 extension buildChildEnv 注入；` +
        `缺失时继续运行会产生无归属的 tee 帧）`,
    );
    return;
  }
  socketPath = process.env[RELAY_ENV_SOCKET];
  if (!socketPath) {
    fail(
      RELAY_EXIT_CODES.MISSING_IDENTITY,
      `${RELAY_ENV_SOCKET} not set（应由 runtime 注入；缺失意味着 relay 激活条件不完整）`,
    );
    return;
  }
  connectWithRetry(socketPath);
}

/** 连接 socket：失败重试一次，再失败退出码 11（runtime 未就绪/路径过期）。 */
function connectWithRetry(path) {
  let attempt = 0;
  const tryConnect = () => {
    attempt += 1;
    const s = net.createConnection(path);
    s.once("connect", () => {
      // connecting → handshaking：握手帧在 onConnected 内同步写出后立即转入 awaiting_accept
      state = STATE.HANDSHAKING;
      sock = s;
      onConnected(s);
    });
    // error 按当前状态分派：connecting = 不可达（重试/11）；已连接 = 生命线断（12）。
    // 不再无条件重试——已连接后的 ECONNRESET 重连会以重复握手撞 reject，语义错误。
    s.once("error", (err) => {
      if (state !== STATE.CONNECTING) {
        fail(
          RELAY_EXIT_CODES.SOCKET_CLOSED,
          `relay socket error: ${err.message}（生命线断，可能是 runtime 崩溃/重启）. ` +
            "Recovery: 重启 taiji 后重试任务",
        );
        return;
      }
      s.destroy();
      if (attempt <= 1) {
        setTimeout(() => {
          if (state === STATE.CONNECTING) tryConnect();
        }, CONNECT_RETRY_DELAY_MS);
      } else {
        fail(
          RELAY_EXIT_CODES.SOCKET_UNREACHABLE,
          `relay socket unreachable after retry: ${path} (${err.message}). ` +
            `Recovery: 重试任务；持续失败请重启 taiji（runtime 未运行或已重启）`,
        );
      }
    });
    // close 按当前状态分派：connect 前的 close 归 error→重试/11 路径；已连接后断 =
    // 生命线断（崩溃矩阵②的 extension 侧感知机制）。
    s.on("close", () => {
      if (state !== STATE.CONNECTING && state !== STATE.CLOSING) {
        fail(
          RELAY_EXIT_CODES.SOCKET_CLOSED,
          "relay socket closed by runtime（生命线断，可能是 runtime 崩溃/重启）. " +
            "Recovery: 重启 taiji 后重试任务",
        );
      }
    });
  };
  tryConnect();
}

/** 连接建立（handshaking）：发握手帧 + 挂 socket 侧监听，同步转入 awaiting_accept（计时起算）。 */
function onConnected(s) {
  const handshake = {
    v: RELAY_PROTOCOL_VERSION,
    kind: "handshake",
    mainSessionId: process.env[RELAY_ENV_SESSION_ID],
    recordId: process.env[RELAY_ENV_RECORD_ID],
    argv: process.argv.slice(2),
    env: { ...process.env },
    cwd: process.cwd(),
  };
  s.write(JSON.stringify(handshake) + "\n");

  // 帧本体是 JSON 文本（payload 已 b64 化），utf8 安全；setEncoding 按字符边界切分，
  // 多字节 UTF-8（中文 argv/env/cwd 值）跨 chunk 不撕裂——与 session-runner.ts stdout 同款先例。
  s.setEncoding("utf8");
  s.on("data", (chunk) => {
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      handleLine(line);
    }
  });
  // 背压方向 1 的恢复：socket 写缓冲排空后恢复读 stdin。必须检查状态——事故根因即
  // 此处无条件 resume：大 handshake 触发 accept 前的 drain，把无监听的 stdin 切成
  // flowing，预写的 prompt 被读出即丢弃（设计 §2.3）。
  s.on("drain", () => {
    if (state === STATE.PUMPING) stdin.resume();
  });

  // handshaking → awaiting_accept：握手已写出，accept 回执窗口自此起算
  state = STATE.AWAITING_ACCEPT;
  armAcceptTimer();
}

/** accept 回执计时：超时 = runtime 侧 spawn/handshake 卡死或已死，显式失败（退出码 15）。 */
function armAcceptTimer() {
  acceptTimer = setTimeout(() => {
    acceptTimer = null;
    fail(
      RELAY_EXIT_CODES.ACCEPT_TIMEOUT,
      `relay accept timeout: runtime did not accept handshake within ${ACCEPT_TIMEOUT_MS}ms ` +
        `(socket: ${socketPath}). ` +
        "Recovery: 检查 runtime 日志（是否卡在 spawn/handshake）；重启 taiji 后重试任务",
    );
  }, ACCEPT_TIMEOUT_MS);
}

/** accept 先到停表（计时窗只在 awaiting_accept 有效）。 */
function stopAcceptTimer() {
  if (acceptTimer !== null) {
    clearTimeout(acceptTimer);
    acceptTimer = null;
  }
}

/** 逐帧分发：按当前状态分派（closing 幂等忽略；pumping 宽容转发；其余按握手期严格语义）。 */
function handleLine(line) {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    fail(
      RELAY_EXIT_CODES.SOCKET_CLOSED,
      `unparseable relay frame (len ${line.length}): ${line.slice(0, 80)}`,
    );
    return;
  }
  // closing（终态）：超时/信号/断连后迟到的 accept/reject/data/exit 一律忽略，
  // 不再转移（幂等）。
  if (state === STATE.CLOSING) return;
  if (state === STATE.PUMPING) {
    handlePumpFrame(frame);
    return;
  }
  // handshaking 是 onConnected 内的同步瞬态，帧回调实际只会落在 awaiting_accept
  handlePreAcceptFrame(frame);
}

/**
 * awaiting_accept 帧语义（严格）：accept/reject 定转移；data 帧缓冲不判死（回放至
 * pumping）；其余帧即协议违例 → 12。
 */
function handlePreAcceptFrame(frame) {
  if (frame.kind === "reject") {
    if (frame.reason === "version") {
      fail(
        RELAY_EXIT_CODES.VERSION_MISMATCH,
        `relay protocol version mismatch: agent v${RELAY_PROTOCOL_VERSION}, ` +
          `runtime supports ${JSON.stringify(frame.supported)}. ` +
          "Recovery: 升级 taiji（runtime 与代理资产同包分发，版本不一致意味着安装损坏，重装应用）",
      );
      return;
    }
    // 非 version 的 reject（如握手校验失败）无专用退出码：socket 语义不可用，归 12。
    fail(
      RELAY_EXIT_CODES.SOCKET_CLOSED,
      `handshake rejected by runtime: ${String(frame.reason)}`,
    );
    return;
  }
  if (frame.kind === "accept") {
    // accept 先到：停表，进入泵模式
    stopAcceptTimer();
    startPump();
    return;
  }
  if (frame.kind === "data" && typeof frame.b64 === "string") {
    // 早到数据帧（runtime 在 accept 前推流）不再报 unexpected-exit-12：缓冲至 pumping
    // 后按泵期语义回放——「accept 前预写不丢」。上限防御：正常形态 accept 窗口内
    // 不会有帧，超限 = runtime 协议违例。
    const bytes = Buffer.byteLength(String(frame.b64));
    if (preAcceptDataBytes + bytes > PRE_ACCEPT_DATA_BUFFER_LIMIT) {
      fail(
        RELAY_EXIT_CODES.SOCKET_CLOSED,
        `pre-accept data frames exceed buffer limit (${PRE_ACCEPT_DATA_BUFFER_LIMIT} bytes) — runtime protocol violation`,
      );
      return;
    }
    preAcceptDataBytes += bytes;
    preAcceptDataFrames.push(frame);
    return;
  }
  fail(
    RELAY_EXIT_CODES.SOCKET_CLOSED,
    `unexpected frame before accept: ${String(frame.kind)}`,
  );
}

/**
 * pumping 帧语义（宽容）：up/up-stderr 转发、exit 传播；未知帧 kind / down 方向回发
 * 记 stderr 忽略——编排通路（extension 的 RPC 消费）优先于严格协议报错，留前向兼容
 * 演进余地。awaiting_accept 缓冲的早到帧也经此路径回放（「转发」语义单点）。
 */
function handlePumpFrame(frame) {
  if (frame.kind === "data" && (frame.dir === "up" || frame.dir === "up-stderr")) {
    if (typeof frame.b64 === "string") {
      writeUp(Buffer.from(frame.b64, "base64"), frame.dir);
    }
    return;
  }
  if (frame.kind === "exit") {
    exitByFrame(frame.code, frame.signal);
    return;
  }
  stderr.write(`[relay] ignoring unexpected frame: kind=${String(frame.kind)} dir=${String(frame.dir)}\n`);
}

/**
 * awaiting_accept → pumping 转移（唯一入口；入口状态守卫是结构性约束——字节泵监听器
 * 不得早于 accept 挂载）。
 * - down：stdin chunk → base64 帧 → socket；socket 写缓冲高水位时 pause stdin、drain 恢复。
 * - up：见 writeUp。
 * - 内部顺序固定（设计 §3.4.1）：挂监听器 → 置 pumping → 回放早到帧 → resume。
 */
function startPump() {
  if (state !== STATE.AWAITING_ACCEPT) return;
  stdin.on("data", (chunk) => {
    if (state === STATE.CLOSING || !sock || sock.destroyed) return;
    const ok = sock.write(
      JSON.stringify({
        v: RELAY_PROTOCOL_VERSION,
        kind: "data",
        dir: "down",
        b64: chunk.toString("base64"),
      }) + "\n",
    );
    if (!ok) stdin.pause();
  });
  // stdin error = 宿主侧管道断（extension 死了）——生命线同类，归 12。
  stdin.on("error", (err) => {
    fail(RELAY_EXIT_CODES.SOCKET_CLOSED, `stdin broken (host may have exited): ${err.message}`);
  });
  // extension 关闭代理 stdin（EOF）：协议无 stdin-EOF 帧且不新增（演进克制）——现状
  // spawn 语义下 stdin 生命周期与进程 kill 绑定，runtime 的 exit 帧才是权威退出信号，
  // 此处保持连接等待，不自行退出。
  stdin.on("end", () => {});
  // 状态置 pumping 在挂完监听器之后、resume 之前：resume 后读出的字节必然有监听器接住。
  state = STATE.PUMPING;
  // 回放 awaiting_accept 期间缓冲的早到数据帧（up 转发 / down 走泵期宽容路径），
  // 先于 stdin.resume——恢复读 stdin 前先把更早到达的字节送到出口。
  const buffered = preAcceptDataFrames;
  preAcceptDataFrames = [];
  preAcceptDataBytes = 0;
  for (const frame of buffered) handlePumpFrame(frame);
  stdin.resume();
}

/**
 * up 帧写出（stdout/stderr）。背压：write 返回 false = 该出口高水位 → 暂停 socket 读
 * （数据滞留 socket 接收缓冲，不丢字节不撑内存）；该出口 drain 且另一出口也无 pending
 * drain 时恢复读。pending drain 监听的存在性即该出口的拥堵标志。
 */
function writeUp(buf, dir) {
  if (state === STATE.CLOSING) return;
  const target = dir === "up-stderr" ? stderr : stdout;
  if (target.write(buf)) return;
  target.once("drain", maybeResumeSocket);
  sock.pause();
}

function maybeResumeSocket() {
  if (
    state === STATE.PUMPING &&
    stdout.listenerCount("drain") === 0 &&
    stderr.listenerCount("drain") === 0 &&
    sock
  ) {
    sock.resume();
  }
}

/** exit 帧处理：signal 优先（extension 侧 close(code, signal) 与真实 pi 死法对齐），否则按 code。 */
function exitByFrame(code, signal) {
  const sig = typeof signal === "string" && signal ? signal : null;
  if (sig) {
    const signum = os.constants.signals[sig];
    if (typeof signum === "number") {
      enterClosing();
      try {
        stdin.destroy();
      } catch {}
      try {
        sock?.destroy();
      } catch {}
      // 真实信号自杀：未注册 handler 的终止类信号必然终止进程，spawn 方观察到
      // (code=null, signal=sig)，与真实 pi 被信号杀死完全同构。信号路径不等 stdout
      // flush——内核 pipe 缓冲中已 write 的字节对端仍可读，node 内部队列丢弃与真实
      // 进程被杀的行为一致。万一信号被环境截胡（理论不发生），fallback 128+signum。
      process.kill(process.pid, sig);
      process.exit(128 + signum);
    }
    fail(RELAY_EXIT_CODES.SOCKET_CLOSED, `exit frame carried unmappable signal: ${sig}`);
    return;
  }
  exitGracefully(typeof code === "number" ? code : 1);
}

/** 失败退出：先确保 stderr 诊断行 flush 到对端，再走通用退出清理。 */
function fail(code, message) {
  if (!enterClosing()) return;
  writeFlushed(stderr, `[relay] ${message}\n`, () => flushStdoutThenExit(code));
}

/** 正常退出（exit 帧 code 路径）：尽力 flush stdout 已排队字节后退出。 */
function exitGracefully(code) {
  if (!enterClosing()) return;
  flushStdoutThenExit(code);
}

/**
 * 写一段数据并等它 flush（callback / 1s 兜底 / 写异常三路都推进）。
 * 为什么必须等：process.exit 立即返回，pipe 模式的异步写会丢——错误诊断丢了对端就
 * 只剩裸退出码，违反「错误信息必须可操作」。
 */
function writeFlushed(stream, data, next) {
  let advanced = false;
  const advance = () => {
    if (advanced) return;
    advanced = true;
    next();
  };
  // 定时器保持 ref：进程因未销毁的流而存活，到期必触发；unref 的 timer 在无其他
  // 事件源时不会执行，会导致静默以 code 0 自然退出（误导 extension「成功」）。
  const timer = setTimeout(advance, FLUSH_TIMEOUT_MS);
  try {
    stream.write(data, () => {
      clearTimeout(timer);
      advance();
    });
  } catch {
    clearTimeout(timer);
    advance();
  }
}

/** stdout 队列已空则立即退，否则等 drain（1s 兜底防对端停读挂死）。 */
function flushStdoutThenExit(code) {
  if (stdout.writableLength === 0) {
    forceExit(code);
    return;
  }
  let advanced = false;
  const advance = () => {
    if (advanced) return;
    advanced = true;
    forceExit(code);
  };
  // 定时器保持 ref（理由同 writeFlushed）：进程因未销毁的流而存活，到期必触发。
  const timer = setTimeout(advance, FLUSH_TIMEOUT_MS);
  stdout.once("drain", () => {
    clearTimeout(timer);
    advance();
  });
}

/**
 * 最终退出：destroy stdin 与 socket（防流句柄悬挂阻塞退出）；stdout/stderr 不 destroy
 * ——destroy 会丢弃已排队未 flush 的转发字节，协议保真优先（flush 等待已在上游完成）。
 */
function forceExit(code) {
  try {
    stdin.destroy();
  } catch {}
  try {
    sock?.destroy();
  } catch {}
  process.exit(code);
}
