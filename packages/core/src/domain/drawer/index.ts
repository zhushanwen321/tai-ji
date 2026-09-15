/**
 * drawer 域入口 —— @taiji/core 的 drawer 域聚合 barrel。
 *
 * 子域：types（共享类型）/ control（per-session 控制态 + 分区键绑定 + 内部原语）/ coordination
 * （模块级公开 API + 瞬时参数）/ terminal-write-queue（终端写队列状态机工厂：write 副作用注入）。
 * [P4 s5 drawer-widget-removal] widget-buffers（widget/status 缓冲容器）已随旧 widget 通道删除
 * （PluginViewContainer 承接）。W1 迁移 useSideDrawer 的控制态/协同逻辑入 core（drawer 域是第一个
 * 「迁实现而非仅迁类型」的域），core 保持 headless（零 pinia/tasks store 依赖，零事件总线），
 * 分区键经 bindDrawerSessionId 注入、write 副作用经 writeFn 注入。承接架构文档
 * §10.2（旧层 → core/domain/* 映射）。
 *
 * 迁移过渡期（renderer 旧 SideDrawer 未删）：renderer useSideDrawer.ts / useDrawerWidgetBuffers.ts
 * / stores/terminal-write-queue.ts 为 re-export/壳层接线兼容（不持有业务状态），旧调用方零改动；
 * core/domain/drawer 为 SSOT。
 *
 * 依赖方向（C3/C4）：coordination → control → foundation/use-session-scoped-state；
 * terminal-write-queue 仅依赖 foundation + 类型。control 不 import coordination
 * （防循环）。
 */
export * from './types'
export * from './control'
export * from './coordination'
export * from './terminal-write-queue'
