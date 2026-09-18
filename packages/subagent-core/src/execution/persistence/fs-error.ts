// src/execution/persistence/fs-error.ts
//
// fs 错误「路径不存在」判别原语（读失败与合法缺省分通道的共享判据）。
//
// 统一模式（2026-09-17 错误处理审查 A11/A7）：目录/文件级读失败禁止与「合法缺省」
// 同判——ENOENT（目标不存在：冷查未命中 / 首跑窗口 / 配置缺席）是合法缺省，调用方
// 保持低级别（静默 / debug）；其余（EACCES / EIO / ENOTDIR 等真 IO 故障）必须 warn
// 留痕——静默空表会把 IO 故障伪装成 not-found，冷查链 / 配置回退的消费方无从分辨。
// 消费方：manifest-store.listAllSync / record-store.reconstructAll / engine/config
// .readExplicitEngines。同判先例：sessions-index.readIndexFile（ENOENT 静默、其余
// debug）。

import { errorCodeOf } from "../../shared/fs-error.ts";

/**
 * 判定错误是否为「目标不存在」（Node errno code = ENOENT）。
 * code 提取单源 = shared/fs-error.errorCodeOf（与 sessions-index 同一判别原语）。
 */
export function isMissingFsError(err: unknown): boolean {
  return errorCodeOf(err) === "ENOENT";
}
