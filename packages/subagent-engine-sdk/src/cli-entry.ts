// src/cli-entry.ts
//
// 引擎 CLI 进程入口样板单源（S4 簇 2 收编：pi/zcode 两包 main.ts 的逐字同构段
// 迁移——差异仅 component 字符串与各包自己的 EngineProtocolServer；实现以 pi
// main.ts 为基线逐字迁移，坏行截断长度 200、日志格式、启动序逐字节保持）。
//
// 职界分割：armEngineSelfDestruct 与 EngineProtocolServer 构造留调用方薄层——
// server 构造需要 arm 产出的 ReverseRequestClock，实例传入后无法回补。本入口承接
// 其余启动序：configureLoggerSink（stderr 兜底 + host/log 反向请求）→ readline
// NDJSON 行循环 → close 留痕。
//
// stdout/stdin 用 process 全局（与 spawn.ts 同款先例——入口函数只在进程入口调用）。
// 进程退出面：宿主 stdin EOF → 自灭守卫（薄层 arm）杀进程组；正常 dispose 不退进程。

import * as readline from "node:readline";

import { configureLoggerSink, getLogger } from "./logger.ts";

/**
 * 引擎协议服务器的结构化最小接口（调用方薄层注入本包 EngineProtocolServer 实例；
 * 结构子集避免 SDK 反向依赖各包 server 类型）。
 */
export interface CliProtocolServerSink {
  /** 入站协议帧处理（readline 已拆行 + JSON.parse 后的帧）。 */
  handleFrame(frame: unknown): void;
  /** 数据面反向请求（host/log 等；应答分类由各包 server 实现承载）。 */
  reverseRequest(method: string, params: unknown): Promise<unknown>;
}

/** runEngineCliEntry 参数。 */
export interface RunEngineCliEntryOptions {
  /** logger component 标签（如 "pi-engine-cli" / "zcode-engine-cli"）。 */
  component: string;
  /** 调用方构造的协议服务器实例（构造参数含 armEngineSelfDestruct 产出的 reverseClock）。 */
  server: CliProtocolServerSink;
}

/** 坏行进日志的截断长度（够诊断、不刷屏）。 */
const INBOUND_LOG_CHARS = 200;

/**
 * 引擎 CLI 进程入口样板（行为与收编前两包 main.ts 逐字节等价）：
 * configureLoggerSink → stdin 行解析（NDJSON）→ server.handleFrame → close 留痕。
 */
export function runEngineCliEntry(opts: RunEngineCliEntryOptions): void {
  const logger = getLogger(opts.component);
  const server = opts.server;

  // stdout 是协议独占通道：应用日志一律走 host/log 反向请求 + stderr 兜底，禁写 stdout。
  configureLoggerSink({
    log(level, component, message, data) {
      // stderr 兜底先落（反向通道未就绪/失败时日志不丢）；host/log 为数据面反向请求
      // （10s 应答分类），失败吞掉——日志面不能拖垮主链路。
      // debug 不写 stderr：对齐 logger.ts CONSOLE_SINK 的「debug no-op」语义——
      // 引擎 stderr 落宿主 [rpc:stderr] 全量 ERROR 级链路，debug 刷屏会淹没真异常
      // （常态路径的分级降噪依赖此跳过）；host/log 反向请求仍全级别透传。
      if (level !== "debug") {
        process.stderr.write(`[${level}] [${component}] ${message}${data !== undefined ? ` ${JSON.stringify(data)}` : ""}\n`);
      }
      void server.reverseRequest("host/log", { level, component, message }).catch(() => undefined);
    },
  });

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const text = line.trim();
    if (text === "") return;
    try {
      server.handleFrame(JSON.parse(text));
    } catch (err) {
      // 坏行跳过不断流（对端 EngineClient 同款纪律）；stdout 协议通道不回显坏行。
      logger.warn(`unparseable inbound protocol line (ignored): ${text.slice(0, INBOUND_LOG_CHARS)}`, {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });
  rl.on("close", () => {
    // stdin EOF：自灭守卫已挂（armEngineSelfDestruct 的 once('close') 杀进程组）；
    // 此处仅留痕（守卫先注册，杀链不依赖本 handler）。
    logger.debug("stdin closed (host exit path)");
  });
}
