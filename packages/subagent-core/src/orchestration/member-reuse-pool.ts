// src/orchestration/member-reuse-pool.ts
//
// [D1 拆边 Class C 第 4 步 → 过渡 re-export] 成员复用绑定池本体已整体下沉
// `execution/service/member-reuse-pool.ts`（消除 `service/workflow-dispatch` →
// 编排层的值反向边；依赖面核查与下沉理由见新址文件头）。
//
// 本文件只保留编排侧消费面的同名 re-export——terminal-actions（收尾清空）、
// worker-message-pump（活体绑定同步读取）与成员复用池测试的导入面零改动；execution
// 侧消费者（service/workflow-dispatch）已改直连新址。re-export 方向 = 编排层 →
// execution（合法向下），不引入值依赖环。

export {
  clearMemberReusePool,
  foldMemberBindings,
  lookupMemberRecordId,
  peekMemberRecordId,
  registerMemberRecord,
  resetMemberReusePoolsForTest,
} from "../execution/service/member-reuse-pool.ts";
export type { MemberReusePoolIo } from "../execution/service/member-reuse-pool.ts";
