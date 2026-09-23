// src/execution/engine/paths.ts
//
// 引擎数据目录布局的 re-export shim：实现体单源 @zhushanwen/subagent-engine-sdk
// （自本文件逐字等价移入 SDK，迁移处置 impl-plan §2.1 登记的「core 侧引用切换」收口）。
// 设计决策（C-ext-15 同源推导要求单源）：engines 根锚定 getDataDir() 顶层。
//
// 本文件路径是 core package.json exports `./engine/paths` 子入口的解析目标，
// 不可移动/删除（semver 面无损）；core 内消费方（pool-manager / journal-wiring /
// session-view-service / routing 测试）import 路径保持不变。

export {
  sanitizeSeg,
  resolveEnginesRoot,
  resolveEngineDir,
  resolvePoolDir,
  resolveJournalPath,
} from "@zhushanwen/subagent-engine-sdk";
