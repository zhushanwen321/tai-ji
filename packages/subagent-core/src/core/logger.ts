// src/core/logger.ts
//
// core log facade（替代 @zhushanwen/pi-extension-logger 的 core 内统一入口）。
// 设计权威源：docs/architecture/subagent-core-package-extraction.md §3.3 D2「解析时机契约」。
//
// 为什么是 facade 代理而不是绑死实现：切面内 30 处既有惯例是模块顶层
// `const logger = getLogger(...)`（模块加载期创建并缓存实例，彼时宿主必然尚未
// configureCore）。若 getLogger 在创建时就绑定当时配置态，先加载的模块会永远落
// 缺省 console——典型时序陷阱。facade 在每次方法调用时经 host-services 配置态
// 动态解析当前宿主实现：configureCore 前落缺省 console，配置后已缓存的顶层
// logger 透明切换到宿主实现，无模块加载顺序依赖（该时序契约由 logger.test.ts
// 顶层缓存用例直接守护）。

import { getHostServices } from "./host-services.ts";

/** 日志级别。级别集合对齐 pi-extension-logger（其 LogLevel 为包内部类型、含 info 四值；实例 API 仅 debug/warn/error 三方法，core facade 据此收窄为三值）。 */
export type LogLevel = "debug" | "warn" | "error";

/** core logger 接口。与 pi-extension-logger 的 ExtensionLogger 结构兼容——
 *  u0-log 批次替换是纯 import 源替换，调用面（方法名/参数序）逐文件等价。 */
export interface CoreLogger {
  debug(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

// 与 pi-extension-logger 的 getLogger singleton 惯例对齐（同 component 同引用）。
// facade 自身无状态（解析发生在方法内），缓存只为引用稳定，不影响透明切换。
const facadeCache = new Map<string, CoreLogger>();

export function getLogger(component: string): CoreLogger {
  const existing = facadeCache.get(component);
  if (existing) return existing;
  const facade: CoreLogger = {
    debug(msg, data) {
      getHostServices().log("debug", component, msg, data);
    },
    warn(msg, data) {
      getHostServices().log("warn", component, msg, data);
    },
    error(msg, data) {
      getHostServices().log("error", component, msg, data);
    },
  };
  facadeCache.set(component, facade);
  return facade;
}
