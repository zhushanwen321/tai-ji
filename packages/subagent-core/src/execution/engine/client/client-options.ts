// src/execution/engine/client/client-options.ts
//
// EngineClient 构造参数与 spawn 配套 helper（自 engine-client.ts 拆出——max-lines
// 纪律）。字段级语义注释随定义走；EngineClient 是唯一消费者。

import { basename } from "node:path";

import {
  getLogger,
  type EngineCapabilities,
  type EngineRelayEnv,
  type HostLogParams,
  type HostPermissionParams,
  type InitializeResult,
  type ModelCatalogEntry,
  type UiRequestHandler,
} from "@zhushanwen/subagent-engine-sdk";

const logger = getLogger("subagents");

import type { MirrorChangeEvent } from "./mirror.ts";

/** EngineClient 构造参数。 */
export interface EngineClientOptions {
  engineId: string;
  /** 引擎 CLI 入口（descriptor command 解析后的绝对路径/可执行名）。 */
  command: string;
  args: readonly string[];
  cwd?: string;
  /** 宿主种类（pidfile 实例维度命名段：'pi' | 'runtime' | …）。 */
  hostKind: string;
  hostVersion?: string;
  /** 引擎数据根（= L0 注入的 XYZ_AGENT_DATA_DIR 值；pidfile 目录与 hostInfo.dataRoot 同源）。 */
  dataDir: string;
  /** 宿主 env 基座（buildEngineChildEnv baseEnv；缺省 = {...process.env}）。 */
  baseEnv?: Record<string, string | undefined>;
  // ── buildEngineChildEnv 的 L0/L2 余项（透传）──
  engineNode?: string;
  electronRunAsNode?: boolean;
  relay?: EngineRelayEnv;
  identityEnv?: Record<string, string | undefined>;
  envPrefixes?: readonly string[];
  processEnv?: Record<string, string | undefined>;
  /** L3 显式配置（initialize.engineConfig 透传；缺省 {}，不放凭据）。 */
  engineConfig?: Record<string, string>;
  /**
   * host/askUser 应答端（[D4-④] 唯一注入入口 = subagent-service init.uiRequestHandler；
   * W6 拆 HostBridge 时接线）。缺省 → 引擎收 {unsupported:true} 自行降级。
   */
  uiRequestHandler?: UiRequestHandler;
  /** host/permission 应答端（v1 骨架注入点）。缺省 → {unsupported:true}。 */
  permissionHandler?: (params: HostPermissionParams) => Promise<{ approved: boolean }>;
  /** host/log 落宿主日志（缺省 SDK logger facade）。 */
  log?: (params: HostLogParams) => void;
  /** 镜像状态广播接线（W6 notify 合并窗口 / 生命周期谓词）。 */
  onMirrorChanged?: (event: MirrorChangeEvent) => void;
  /** 引擎 cmdline 身份谓词覆盖（pidfile 三条件清扫防误杀校验；缺省按 command 词形）。 */
  engineCmdlineMatcher?: (cmdline: string) => boolean;
  /** manifest 诊断源（initialize 应答与 manifest 不一致 → warn 留痕，不参与判据）。 */
  manifestDiagnostics?: {
    capabilities?: EngineCapabilities;
    models?: ModelCatalogEntry[] | null;
  };
}



/** 缺省 cmdline 身份谓词：cmdline 含 command 全路径，或含以引擎入口 basename 结尾的词。 */
export function defaultEngineCmdlineMatcher(command: string): (cmdline: string) => boolean {
  const base = basename(command);
  return (cmdline: string) => {
    if (cmdline.includes(command)) return true;
    return cmdline.split(/\s+/).some((arg) => arg === command || arg.endsWith(`/${base}`));
  };
}

/** models 声明空占位判定（null/undefined/[]）：无真值基线，应答空值形态差异不构成漂移证据。 */
function isEmptyModelsDeclaration(models: ModelCatalogEntry[] | null | undefined): boolean {
  return models == null || models.length === 0;
}

/** manifest 诊断比对（应答仅诊断：不一致 → warn 留痕，不参与判据；EngineClient 握手尾调用）。 */
export function warnOnManifestDiagnostics(
  engineId: string,
  diag: { capabilities?: EngineCapabilities; models?: ModelCatalogEntry[] | null } | undefined,
  result: InitializeResult,
): void {
  if (diag?.capabilities) {
    const answered = JSON.stringify(result.capabilities ?? null);
    const declared = JSON.stringify(diag.capabilities);
    if (answered !== declared) {
      logger.warn(
        `[engine-client:${engineId}] initialize capabilities differ from manifest `
          + `(diagnostic only): manifest=${declared} answered=${answered}`,
      );
    }
  }
  // 声明侧空占位（null/undefined/[]）跳过比对：无真值基线，应答 null/[] 的空值形态
  // 差异不构成漂移证据（曾产 "manifest=[] answered=null" 噪音）。声明非空而应答为空
  // 仍进入比对 → warn（真漂移不吞）。
  if (diag && "models" in diag && !isEmptyModelsDeclaration(diag.models)) {
    const answered = JSON.stringify(result.models ?? null);
    const declared = JSON.stringify(diag.models ?? null);
    if (answered !== declared) {
      logger.warn(
        `[engine-client:${engineId}] initialize models differ from manifest `
          + `(diagnostic only): manifest=${declared} answered=${answered}`,
      );
    }
  }
}
