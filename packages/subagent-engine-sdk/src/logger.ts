// src/logger.ts
//
// 日志 facade（引擎侧原语，自 core src/core/logger.ts 迁入 @zhushanwen/subagent-engine-sdk）。
// 迁移处置（impl-plan §2.1：「日志 facade」直接搬；kill-chain 行「logger 走 SDK facade」）：
// core 版经 getHostServices()（configureCore 时序契约）动态解析宿主实现；SDK 进程
// （引擎 CLI）无 configureCore 通道，同款「调用时动态解析」语义改为经可注入
// LoggerSink——引擎 CLI 启动早期 configureLoggerSink(sink) 注入宿主形态 sink，
// 未注入时落缺省 console 出口（对齐 core NULL_HOST.log 语义：warn/error 走 console、
// debug no-op）。facade 代理而非绑死实现的时序契约（模块顶层 getLogger 先于配置、
// 配置后透明切换）与 core 版逐字一致。
//
// CJS 多 entry 内联副本的实例分裂影响 = facadeCache 分裂（同 component 引用不同）；
// facade 无状态、sink 解析每次调用发生，无语义后果——与 core 版同结论。

/**
 * SDK 侧 logger sink（引擎 CLI 注入宿主形态日志出口；core 版对应 HostServices.log）。
 */
export interface LoggerSink {
  log(level: LogLevel, component: string, message: string, data?: unknown): void;
}

/** 日志级别。对齐 core logger 的 LogLevel（三值，无 info）。 */
export type LogLevel = "debug" | "warn" | "error";

/** logger 接口。与 core CoreLogger 结构兼容——迁移调用面（方法名/参数序）逐文件等价。 */
export interface CoreLogger {
  debug(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

// sink 配置态：globalThis[Symbol.for] slot（core host-services 同款范式）——模块级
// `let` 在 dist 双形态 / CJS 多 entry 内联副本下会被分裂，slot 形态跨副本一致。
const SINK_SLOT_KEY = Symbol.for("@zhushanwen/subagent-engine-sdk.logger-sink");

type SinkSlot = { current: LoggerSink | undefined };

function getSinkSlot(): SinkSlot {
  let slot = Reflect.get(globalThis, SINK_SLOT_KEY) as SinkSlot | undefined;
  if (!slot) {
    slot = { current: undefined };
    Reflect.set(globalThis, SINK_SLOT_KEY, slot);
  }
  return slot;
}

/** 缺省 console 出口（未注入 sink 时的日志不丢）。格式对齐 core NULL_HOST.log。 */
const CONSOLE_SINK: LoggerSink = {
  log(level, component, message, data) {
    const line = `[${component}] ${message}`;
    // data 作第二参数；缺省时必须省略——node console 会把显式 undefined 格式化成
    // " undefined" 尾巴污染每行输出。
    if (level === "error") {
      if (data === undefined) console.error(line);
      else console.error(line, data);
      return;
    }
    if (level === "warn") {
      if (data === undefined) console.warn(line);
      else console.warn(line, data);
      return;
    }
    // debug 缺省 no-op：对齐 core NULL_HOST 语义（未配置期多为模块加载窗口，刷屏无
    // 诊断价值）；warn/error 不可静默。
  },
};

function currentSink(): LoggerSink {
  return getSinkSlot().current ?? CONSOLE_SINK;
}

/**
 * 注入日志 sink（引擎 CLI 启动早期调用；重复调用后者覆盖——测试切 sink 依赖此语义）。
 * 解析发生在每次 logger 方法调用时，模块顶层已缓存的 logger 透明切换，无加载顺序依赖。
 */
export function configureLoggerSink(sink: LoggerSink): void {
  getSinkSlot().current = sink;
}

/** 测试隔离专用：清空 sink 配置态（生产禁用）。 */
export function resetLoggerSinkForTests(): void {
  getSinkSlot().current = undefined;
}

// 与 core getLogger singleton 惯例对齐（同 component 同引用）。
// facade 自身无状态（解析发生在方法内），缓存只为引用稳定，不影响透明切换。
const facadeCache = new Map<string, CoreLogger>();

export function getLogger(component: string): CoreLogger {
  const existing = facadeCache.get(component);
  if (existing) return existing;
  const facade: CoreLogger = {
    debug(msg, data) {
      currentSink().log("debug", component, msg, data);
    },
    warn(msg, data) {
      currentSink().log("warn", component, msg, data);
    },
    error(msg, data) {
      currentSink().log("error", component, msg, data);
    },
  };
  facadeCache.set(component, facade);
  return facade;
}
