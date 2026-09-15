/**
 * composer-injection-store.ts —— renderer 侧模块级单例（W4 composer-shell-integration）。
 *
 * [归位] 状态逻辑在 @taiji/core/domain/composer/context/injection-store.ts（W3）的
 * createComposerInjectionStore() factory（core 零 pinia 依赖）。原 renderer stores/composer-injection.ts
 * 是 defineStore wrapper（pinia 注册，W3 过渡），W4 删除 wrapper，改为模块级单例持有 core factory
 * 实例——保持 pinia 单例语义（drawer 写入 + composer 消费共享同一 pendingInjection 通道）。
 *
 * 消费者（TerminalView/GitPanel/DetailPane/SessionItem + Composer 壳 useComposerShell）：
 * 统一 const 形态直接 import `composerInjectionStore` 单例（u20 删除 useComposerInjectionStore()
 * 兼容函数——同一单例的两套调用形态并存无语义差，留一即可）。
 *
 * 注意：pendingInjection 是 core factory 的 ref（.value 消费），pinia store 解包语义已不存在
 * （core factory 直接返回 Ref 形态，无需 storeToRefs）。
 */
import { createComposerInjectionStore } from '@taiji/core/domain/composer/context'

/** 模块级单例（drawer 写入方与 composer 消费方共享同一实例，一次性消息通道语义） */
export const composerInjectionStore = createComposerInjectionStore()

export type { InjectionTarget, PendingInjection, InjectionRequest } from '@taiji/core/domain/composer/context'
