#!/usr/bin/env node
/**
 * subagent relay 代理 CLI。
 *
 * 角色：双面字节泵——extension 眼中的 pi 子进程（stdio 与 spawn 真实 pi 字节级同构：
 * 逐行 JSONL RPC / get_state 握手由 extension 侧 session-runner 原样驱动，代理只搬运字节）
 * × runtime 眼中的 relay 客户端（本地 socket，先握手后转发）。协议不假设 stdio 是文本
 * 通道，payload 一律 base64 封装保字节精确。
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
 *   | RELAY_EXIT_CODES.*        | RELAY_EXIT_CODES.*        | 10/11/12/13                 |
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
};

/** 首次连接失败到重试的间隔（毫秒）。设计未定值；取短值——只需覆盖 runtime 建 socket 与主 pi spawn 的毫秒级窗口。 */
const CONNECT_RETRY_DELAY_MS = 200;
/** 退出前等待 stderr/stdout flush 的兜底上限（毫秒）：pipe 写是异步的，process.exit 会丢未 flush 数据。 */
const FLUSH_TIMEOUT_MS = 1000;
/** goodbye 帧写出后等待 flush 的兜底上限（毫秒）：runtime 已死等形态下 write 回调永不到达。 */
const GOODBYE_FLUSH_TIMEOUT_MS = 500;

const stdin = process.stdin;
const stdout = process.stdout;
const stderr = process.stderr;

/** 当前 socket 连接（connect 成功后赋值；重试期间为 null）。 */
let sock = null;
/** 握手已被 runtime accept，进入双向泵模式。 */
let handshakeAccepted = false;
/** 退出流程已启动（幂等守卫——error 后必发 close，防双退出路径竞态）。 */
let exiting = false;
/** socket 按行解析的残留缓冲（JSONL 帧）。 */
let lineBuf = "";

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

/** 宿主信号终止：best-effort 发 goodbye → 等 flush（有界）→ 按 128+signo 退出。 */
function hostTerminate(sig) {
  if (exiting) return;
  exiting = true;
  const signum = os.constants.signals[sig];
  const exitCode = 128 + (typeof signum === "number" ? signum : 0);
  const die = () => process.exit(exitCode);
  try {
    if (sock !== null && !sock.destroyed && handshakeAccepted) {
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
  const socketPath = process.env[RELAY_ENV_SOCKET];
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
function connectWithRetry(socketPath) {
  let attempt = 0;
  const tryConnect = () => {
    attempt += 1;
    const s = net.createConnection(socketPath);
    let connected = false;
    s.once("connect", () => {
      connected = true;
      sock = s;
      onConnected(s, socketPath);
    });
    // 未 connect 的 error 走重试/失败；已 connect 的 close = 生命线断（退出码 12）。
    s.once("error", (err) => {
      s.destroy();
      if (attempt <= 1) {
        setTimeout(() => {
          if (!exiting) tryConnect();
        }, CONNECT_RETRY_DELAY_MS);
      } else {
        fail(
          RELAY_EXIT_CODES.SOCKET_UNREACHABLE,
          `relay socket unreachable after retry: ${socketPath} (${err.message}). ` +
            `Recovery: 重试任务；持续失败请重启 taiji（runtime 未运行或已重启）`,
        );
      }
    });
    s.on("close", () => {
      if (connected && !exiting) {
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

/** 连接建立：发握手帧 + 挂 socket 侧监听（数据泵监听在 accept 后才挂，见 startPump）。 */
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
  // 背压方向 1 的恢复：socket 写缓冲排空后恢复读 stdin。
  s.on("drain", () => {
    if (!exiting) stdin.resume();
  });
}

/** 逐帧分发：握手期是严格状态机（必须先 accept/reject），泵期宽容（转发优先）。 */
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
  if (!handshakeAccepted) {
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
      handshakeAccepted = true;
      startPump();
      return;
    }
    fail(
      RELAY_EXIT_CODES.SOCKET_CLOSED,
      `unexpected frame before accept: ${String(frame.kind)}`,
    );
    return;
  }
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
  // 未知帧 kind / down 方向回发：同包同版本下不应出现。宽容忽略保转发——编排通路
  //（extension 的 RPC 消费）优先于严格协议报错，留前向兼容演进余地。
  stderr.write(`[relay] ignoring unexpected frame: kind=${String(frame.kind)} dir=${String(frame.dir)}\n`);
}

/**
 * 双向泵启动（accept 后）：
 * - down：stdin chunk → base64 帧 → socket；socket 写缓冲高水位时 pause stdin、drain 恢复。
 * - up：见 writeUp。
 */
function startPump() {
  stdin.on("data", (chunk) => {
    if (exiting || !sock || sock.destroyed) return;
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
  stdin.resume();
}

/**
 * up 帧写出（stdout/stderr）。背压：write 返回 false = 该出口高水位 → 暂停 socket 读
 * （数据滞留 socket 接收缓冲，不丢字节不撑内存）；该出口 drain 且另一出口也无 pending
 * drain 时恢复读。pending drain 监听的存在性即该出口的拥堵标志。
 */
function writeUp(buf, dir) {
  if (exiting) return;
  const target = dir === "up-stderr" ? stderr : stdout;
  if (target.write(buf)) return;
  target.once("drain", maybeResumeSocket);
  sock.pause();
}

function maybeResumeSocket() {
  if (stdout.listenerCount("drain") === 0 && stderr.listenerCount("drain") === 0 && !exiting && sock) {
    sock.resume();
  }
}

/** exit 帧处理：signal 优先（extension 侧 close(code, signal) 与真实 pi 死法对齐），否则按 code。 */
function exitByFrame(code, signal) {
  const sig = typeof signal === "string" && signal ? signal : null;
  if (sig) {
    const signum = os.constants.signals[sig];
    if (typeof signum === "number") {
      exiting = true;
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
  if (exiting) return;
  exiting = true;
  writeFlushed(stderr, `[relay] ${message}\n`, () => flushStdoutThenExit(code));
}

/** 正常退出（exit 帧 code 路径）：尽力 flush stdout 已排队字节后退出。 */
function exitGracefully(code) {
  if (exiting) return;
  exiting = true;
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
