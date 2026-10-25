// src/execution/engine/client/list-models-face.ts
//
// [listModels 异步面 2026-10-25] RemoteEngine.listModels 的 union 门面本体（独立模块：
// remote-engine.ts 代码行数达 max-lines 上限，行为保持搬移至此，非重构）。
//
// union 语义：manifest 静态快照可枚举（staticModelListOf 四态中返回数组的两态）→
// 同步返回快照（同步消费方经 port.ts syncEngineModelList 窄化保形，行为与快照时代
// 逐字节一致）；无静态枚举（省略 / null / dynamic:true+[]——zcode/pi manifest 均此
// 占位形态）→ 协议 listModels 帧 async RPC 拿引擎活清单——engineDefaults 偏好层
// 成员校验（resolveEngineModelWithTranslation → await）由此获得数据源（此前该形态
// 恒 null 放行，偏好值零成员校验直穿引擎侧才炸 model_not_available）。
//
// RPC 失败语义归调用方（偏好层放行 + per-engine 一次性 warn）；本模块原样上浮
// （EngineSdkError code 保留）。连接锚定：生产消费点（偏好层）位于路由 probe 之后
// ——probe 已按 service 层权威根 ensureConnected（DC-12），无参 ensureConnected 走
// ready 快路径（与 setModel/read 同款，无双连接窗口）。

import type { ModelCatalogEntry } from "@zhushanwen/subagent-engine-sdk";

import { staticModelListOf, type EngineModelList } from "../port.ts";
import type { EngineClient } from "./engine-client.ts";
import type { RemoteEngineManifestSnapshot } from "./remote-engine.ts";

/**
 * 控制范围单请求超时（量级对齐 SET_MODEL_REQUEST_TIMEOUT_MS = 10s 先例）：偏好层
 * 成员校验在**派发同步路径**上 await 本帧——无界等待（request 缺省任务级无墙钟）
 * 会把派发挂死在无应答引擎上；秒级有界 + 超时失败放行（消费方 model-ref-translation
 * 的 per-engine 一次性 warn 语义）。
 */
const LIST_MODELS_REQUEST_TIMEOUT_MS = 10_000;

/**
 * RemoteEngine.listModels 门面：快照可枚举 → 同步数组；无静态枚举 → 活清单 RPC
 * （ListModelsResult.models 单字段；结构互证经 SDK 契约类型）。
 */
export function remoteListModelsFace(
  manifest: RemoteEngineManifestSnapshot,
  client: EngineClient,
): EngineModelList | Promise<EngineModelList> {
  const snapshot = staticModelListOf(manifest.modelCatalog);
  if (snapshot !== null) return snapshot;
  return requestLiveEngineModels(client);
}

/** 协议 listModels 帧载荷消费（ensureConnected 快路径见文件头）。 */
async function requestLiveEngineModels(client: EngineClient): Promise<EngineModelList> {
  await client.ensureConnected();
  const result = (await client.request("listModels", {}, {
    timeoutMs: LIST_MODELS_REQUEST_TIMEOUT_MS,
  })) as {
    models: ModelCatalogEntry[] | null;
  };
  return result.models;
}
