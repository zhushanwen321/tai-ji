// route.ts —— 移动壳五态路由状态机（remote-use-mobile-v2 §6.7，A 级决策）。
//
// 拥有面（本模块是壳层导航状态的唯一权威，App.vue / BottomNav / 各屏组件消费）：
//   - shellRoute：五态路由（三目的域 sessions/activity/settings + 详情页 chat + 验身页 connect）
//   - chatFrom：chat 的来源目的域（从哪个目的域进聊天，返回回哪）
//   - navigateRoute：唯一编程转移入口（表外转移 fail-fast throw）
//   - goBackFromChat：UI 返回按钮出口（= history.back()，转移由 popstate 单点驱动）
//   - setupRouteHistory：popstate 监听装配（bootstrap 挂载后调用一次）
//
// 转移表（显式；表外转移 navigateRoute 直接 throw——编程错误立即暴露，不静默吞）：
//   同态重复            → 幂等 no-op
//   任意 → connect      → 合法（验身失效驱动；connect 态不写历史，§6.7）
//   connect → sessions  → 合法（验身成功驱动；connect 无目的地可言，统一回初始目的域）
//   connect → 其他      → 表外 throw
//   目的域 → 目的域     → 合法（底部导航互切；不写历史——系统返回只关聊天，不逐个回退目的域）
//   目的域 → chat       → 合法（记录 chatFrom + history.pushState 写历史条目）
//   chat → 目的域       → 表外 throw（编程直呼禁入；chat 退出只能走 popstate 路径
//                         （goBackFromChat / 系统侧滑 / Android 返回键）或验身失效 → connect，
//                         保证历史栈与路由状态一致——chat 条目退出即消费，不残留）
//
// 历史栈纪律：栈里只会出现 chat 条目（pushState 唯一写点）。popstate 到达时当前态必是
// chat（该条目对应的状态），此时转移回 chatFrom；非 chat 态收到 popstate = 栈与状态失配
// （编程错误或系统事件噪声），console.error 留痕不转移（fail-visible——生产壳 throw 会
// 白屏，可见错误 + 保持现状是该失配的安全侧）。
//
// 依赖方向：本模块不 import connection-view / bootstrap（连接态 → 路由的驱动接线在
// App.vue watch 段）；route 是导航域，connection-view 是连接装配域，二者正交。

import { ref, type Ref } from 'vue'

/** 壳层五态路由（§6.7）：三目的域 + 聊天详情页 + 验身页 */
export type ShellRoute = 'sessions' | 'activity' | 'settings' | 'chat' | 'connect'

/** 聊天的合法来源 = 三个目的域（chat 自身与 connect 不可能是来源） */
export type ChatSourceDomain = Exclude<ShellRoute, 'chat' | 'connect'>

/** 三目的域清单（BottomNav 布局与转移表判定的同一清单——单一来源） */
const DESTINATION_DOMAINS: readonly ChatSourceDomain[] = ['sessions', 'activity', 'settings']

function isDestinationDomain(route: ShellRoute): route is ChatSourceDomain {
  return (DESTINATION_DOMAINS as readonly string[]).includes(route)
}

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：壳层路由五态（BottomNav/App 消费）
export const shellRoute: Ref<ShellRoute> = ref('connect')

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：chat 来源目的域（非 chat 态恒 null）
export const chatFrom: Ref<ChatSourceDomain | null> = ref(null)

/** 转移表判定（同态幂等在 navigateRoute 入口先行短路，不进本表） */
function isTransitionAllowed(from: ShellRoute, to: ShellRoute): boolean {
  if (to === 'connect') return true
  if (from === 'connect') return to === 'sessions'
  if (from === 'chat') return false
  // 此处 from 必为目的域（connect/chat 已被上方分支排除）：目的域互切 + 目的域进聊天
  return isDestinationDomain(to) || to === 'chat'
}

/**
 * 唯一编程转移入口。表外转移 throw（fail-fast，§6.7 状态机纪律）：
 * 调用方传出不合法的 from → to 组合说明接线错误，静默吞会把导航 bug 藏成「点不动」。
 */
export function navigateRoute(to: ShellRoute): void {
  const from = shellRoute.value
  if (from === to) return
  if (!isTransitionAllowed(from, to)) {
    throw new Error(`[route] 表外转移被拒绝: ${from} → ${to}`)
  }
  applyTransition(to)
}

/** 转移执行（历史写点唯一：目的域 → chat 一次 pushState；connect 不写历史） */
function applyTransition(to: ShellRoute): void {
  const from = shellRoute.value
  if (to === 'chat') {
    // from 必是目的域（转移表已判定）；chatFrom 记录返回目标
    chatFrom.value = from as ChatSourceDomain
    history.pushState({ shellRoute: 'chat' }, '')
  }
  shellRoute.value = to
}

/**
 * UI 返回出口（聊天页顶部返回按钮消费）：显式走 history.back()，让 popstate 成为
 * chat 退出的单点转移驱动——UI 直呼 navigateRoute 会绕过历史栈（栈里残留 chat 条目，
 * 用户随后按系统返回又回到已退出的聊天）。
 */
export function goBackFromChat(): void {
  if (shellRoute.value !== 'chat') return
  history.back()
}

/** popstate 转移：chat 态 → 回来源目的域（栈条目消费，不新写历史）；其余 fail-visible */
function onPopstate(): void {
  if (shellRoute.value !== 'chat') {
    console.error(`[route] popstate 在非 chat 态到达（${shellRoute.value}）——历史栈与路由状态失配，忽略本次事件`)
    return
  }
  const source = chatFrom.value
  if (source === null) {
    console.error('[route] popstate 到达但 chatFrom 缺失——无法定位返回目标，忽略本次事件')
    return
  }
  shellRoute.value = source
  chatFrom.value = null
}

/** popstate 监听装配（bootstrap 挂载后调用一次；重复装配由守卫拦截——单例语义） */
export function setupRouteHistory(): void {
  window.removeEventListener('popstate', onPopstate)
  window.addEventListener('popstate', onPopstate)
}

/**
 * 测试复位（生产代码禁止消费；命名即用途）：路由状态与历史监听归零——模块级单例 ref
 * 跨测试泄漏由各测试文件 beforeEach 调用本函数消除。
 */
export function resetRouteForTesting(): void {
  shellRoute.value = 'connect'
  chatFrom.value = null
  window.removeEventListener('popstate', onPopstate)
}
