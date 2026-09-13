// src/core/host-services.ts
//
// HostServices 宿主端口（P0 依赖闭包 port 化）。设计权威源：
// docs/architecture/subagent-core-package-extraction.md §3.3 D2 + §3.4 错误规格。
//
// core 与宿主（pi 壳 / zsw 壳）的唯一环境服务契约：数据根 / 结构化日志 / 资源发现根。
// 注入时机：宿主壳初始化最早期 configureCore(host)，core 内模块统一经
// getHostServices() 取用——解析发生在每次调用时，宿主后续覆盖配置即刻生效。
//
// dataRoot 分段归属（计划期细化 2026-08-29）：本端口只返回宿主数据根本身——env
// 覆盖段（XYZ_AGENT_DATA_DIR 优先）与 warn-once 语义留在 core data-dir.ts，壳不
// 重复实现。未 configureCore 即消费 dataRoot 抛 core_host_not_configured（§3.4）：
// 「缺省静默漂目录」被显式报错取代，DEFAULT_DATA_ROOT 供宿主显式采用而非 core 内部
// 静默兜底。

import { homedir } from "node:os";
import { join } from "node:path";

import type { LogLevel } from "./logger.ts";

/** 发现根条目：dir 为扫描根路径；source 是宿主提供的语义标签（遮蔽报告透传用）。
 *  source 不枚举封闭集——core 只透传不解释（宿主如 pi 壳用 user-pi/npm/npm-dev）。 */
export interface DiscoveryRoot {
  dir: string;
  source: string;
}

export interface HostServices {
  /** 数据根目录：引擎隔离池 / journal / record 派生存放的锚点。
   *  pi 壳返回 getAgentDir()（独立 pi 用户 journal 不漂目录）；zsw 壳返回 zsw 数据根。 */
  dataRoot(): string;
  /** 结构化日志：对齐现 getLogger 调用面（level/component/message/data）。缺省 sink 按级分化：
   *  warn/error 走 console、debug no-op（对齐 pi-extension-logger 语义，见 NULL_HOST.log）。 */
  log(level: LogLevel, component: string, message: string, data?: unknown): void;
  /** agent/skill/workflow/引擎包 资源发现根（可选端口，缺席 = 调用方降级）。宿主只提供根列表
   *  （按优先级低→高）；扫描 / 同名遮蔽（last-writer-wins）/ 遮蔽报告语义归 core 统一。
   *
   *  engines kind（W4，设计 §3.4 L1 第二通道）：引擎包发现根——dir 下一级（及 org 分组
   *  二级）子项 = 候选引擎包目录，命中 package.json `xyz-agent.subagentEngine` manifest
   *  即发现。打包态主通道是 env `XYZ_AGENT_ENGINE_ROOTS`（W9 注入），此端口承载宿主
   *  自身模块域（如 pi 宿主包 node_modules 的引擎包 dependencies 安装位）。 */
  discoveryRoots?(): {
    agents?: DiscoveryRoot[];
    skills?: DiscoveryRoot[];
    workflows?: DiscoveryRoot[];
    engines?: DiscoveryRoot[];
  };
}

/** core 缺省数据根（~/.subagent-core，homedir 推导——禁止写死绝对路径，排查规则）。
 *  供无自有数据根的轻宿主显式采用；core 自身不静默兜底到该值。 */
export const DEFAULT_DATA_ROOT: string = join(homedir(), ".subagent-core");

// 配置态持有：globalThis[Symbol.for] slot（post-convergence D9 根治）。模块级 `let`
// 在 dist 双形态（主 bundle × 子入口 bundle 各持模块副本）下会被分裂——configureCore
// 只写主 bundle 副本，子入口侧恒 undefined。slot 对象形态（非直接存值）规避
// 「undefined 值与无 key 不可区分」；范式与 execution/subagent-service.ts 进程单例
// slot 同型。读写语义不变：configureCore 覆盖式写入
// （重复调用以后者覆盖——测试切宿主依赖此语义）。
const HOST_SLOT_KEY = Symbol.for("@zhushanwen/subagent-core.host-services");

type HostSlot = { current: HostServices | undefined };

function getHostSlot(): HostSlot {
  let slot = Reflect.get(globalThis, HOST_SLOT_KEY) as HostSlot | undefined;
  if (!slot) {
    slot = { current: undefined };
    Reflect.set(globalThis, HOST_SLOT_KEY, slot);
  }
  return slot;
}

export function configureCore(host: HostServices): void {
  getHostSlot().current = host;
}

/** 测试隔离专用：清空配置态（生产禁用——生产宿主配置一次后生命周期与进程一致）。 */
export function resetCoreForTests(): void {
  getHostSlot().current = undefined;
}

const NULL_HOST: HostServices = {
  dataRoot() {
    // §3.4 core_host_not_configured：错误必须可操作——指出缺失动作（configureCore
    // 的调用时机）+ 双宿主接入示例落点。pi 壳接入文件由后续接线单元（u0-wire）创建。
    throw new Error(
      "[subagent-core] core_host_not_configured: HostServices is not configured — " +
        "the host shell must call configureCore(host) during initialization, before any " +
        "core API that needs host services is consumed. " +
        "Recovery: pi shell wires HostServices in src/host/pi-host.ts of " +
        "@zhushanwen/pi-subagent-workflow; zsw shell: see the wiring example in the " +
        "@zhushanwen/subagent-core package README.",
    );
  },
  log(level, component, message, data) {
    // 缺省 console 出口（configureCore 前的日志不丢）。格式对齐 pi-extension-logger
    // 的 `[extName] msg` 前缀，便于 session 日志逆向检索时两形态互通。
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
    // debug 缺省 no-op：对齐 pi-extension-logger 的 debug 默认 no-op 语义（未配置期
    // 多为模块加载窗口，刷屏无诊断价值）；warn/error 不可静默。
  },
  // discoveryRoots 刻意不实现：可选端口缺席 = undefined，由调用方走缺省发现语义。
};

export function getHostServices(): HostServices {
  return getHostSlot().current ?? NULL_HOST;
}
