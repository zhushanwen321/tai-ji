// src/execution/__tests__/helpers/legacy-sidecar.ts
//
// 兼容期旧格式终态 sidecar fixture（`.finalized` / `.cancelled`）——L4 合并后生产
// 只写 `.state`，但读侧仍兼容旧名（存量文件不迁移）。测试需要造旧格式文件验证兼容
// 读路径，此处是唯一 fixture 入口（格式细节单源，避免各测试散落 fs.writeFileSync）。
//
// 形态 = 合并前两模块的写侧逐字等价：
//   .finalized  内容 = reason 字符串（undefined → 空文件，v8.5 前格式）
//   .cancelled  内容 = 单行 JSON tombstone {id, status, agent, startedAt, endedAt}

import * as fs from "node:fs";

/** 旧 .cancelled tombstone 形态（合并前 CancelledTombstone 逐字等价）。 */
export interface LegacyCancelledTombstone {
  id: string;
  status: "cancelled";
  agent: string;
  startedAt: number;
  endedAt: number;
}

/** 写旧格式 `.finalized`（测试 fixture；reason 缺省 = 空文件旧格式）。 */
export function writeLegacyFinalizedSidecar(sessionFile: string, reason?: string): void {
  fs.writeFileSync(`${sessionFile}.finalized`, reason ?? "", "utf-8");
}

/** 写旧格式 `.cancelled`（测试 fixture；完整 tombstone 形态）。 */
export function writeLegacyCancelledSidecar(
  sessionFile: string,
  meta: LegacyCancelledTombstone,
): void {
  fs.writeFileSync(`${sessionFile}.cancelled`, `${JSON.stringify(meta)}\n`, "utf-8");
}
