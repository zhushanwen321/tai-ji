// src/index.ts
//
// 包入口 + logger 装配点（D1-A：锁实现文件不 import extension-logger——
// lock-core 零依赖约束向上传导至本文件唯一的 logger import 处）。
// runtime 侧经 `@zhushanwen/pi-file-lock/core` 子入口直接用锁原语，不经本文件、
// 不拉 logger 依赖；extension 侧经本文件入口使用，logger 在此注入。

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { setFileLockLogger, withFileLockSync } from "./file-lock";

const logger = getLogger("file-lock");
setFileLockLogger((msg) => logger.debug(msg));

export { withFileLockSync };
