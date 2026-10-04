/*
 * 懒加载 chunk 内部自动重试（display-containers D6 交付后修复，2026-10-03 用户裁决）。
 *
 * 裁决语义：界面不出现重试按钮；装载失败由系统内部有界自动重试兜底；穷尽后才呈现错误态
 * （错误态文案给恢复指引：关闭后重新打开可恢复、Esc/⌘W 可退出——退出与重开路径既有）。
 *
 * 机制（探针实证，证据链见 .tmp/dev-flow/display-containers.runlog/d6-fix-internal-retry.md）：
 * 1. 浏览器 module map 对失败 URL 记忆化（fetch/解析失败记 null，同 URL 再 import 零网络瞬时
 *    再拒）——同 URL 重试对 chunk 失败类自愈不存在（D3-G2 实测 + 本期探针复证）。
 * 2. cache-busting（URL 加 ?t=N 假参数）绕过记忆化：不同 query = 不同 module map key，触发
 *    新加载。file://（dir + asar 双形态）实测 ?t=N 加载成功——推翻旧登记「prod 不可行」断言。
 * 3. vite 指纹 chunk 的 URL 构建期烧死，运行时拿不到——但从**失败错误消息**里可以提取
 *    （Chromium 格式 `Failed to fetch dynamically imported module: <url>`，探针复证）。提取
 *    URL 后 `import(url)`（附 @vite-ignore 标记）走运行时动态 import：构建 spike 实证
 *    rolldown/vite 8 原样保留该表达式、不破坏静态 import 的 chunk 拆分——零构建配置改动。
 *
 * 有界参数依据：3 次 × 300ms 递增退避（累计 ~1.8s）。瞬时类失败（升级替换窗口 / AV 扫描 /
 * dev server 抖动）的恢复窗口在亚秒～秒级，3 次覆盖之；仍失败即持久故障（版本错配 / 文件
 * 缺失），继续重试只推迟错误态出现——穷尽后给指引文案，出路 = 关闭重开（每轮重开均重置
 * 计数重新自动重试）+ Esc/⌘W 退出。
 *
 * 重试驱动形态（Vue 3.5.39 runtime-core 实装核对）：
 * - userOnError 契约：每次失败必须最终 resolve（userRetry）或 reject（userFail），否则 load 链
 *   恒 pending → wrapper 恒停 loading。因此每次退避到点：**userRetry() + retryKey++ 同调**。
 *   userRetry（Vue retry()）= 清 pendingRequest + 立即重跑 loader（本次失败的 load 链在此
 *   结算，busted 重跑的唯一跑点）；retryKey++ 重挂新 wrapper，其 setup 的 load() 经实装的
 *   `pendingRequest ||` 短路共享同一链、结算时置 loaded.value → 内容渲染（旧 wrapper 卸载，
 *   其链结算被 isUnmounted 分支安全吞掉）。已核对：无幽灵 loader 双跑（新 wrapper 短路共享），
 *   无死锁（穷尽 fail → 链 reject → 实装 setup catch 清 pendingRequest → 重开 fresh 重跑）。
 * - 穷尽呈现错误态走 userFail()（reject 当前活跃 wrapper 的链 → error.value 置位 →
 *   errorComponent 渲染）。
 * - 失败未穷尽期间：链 pending → wrapper 停 loading 占位（**非错误态**——瞬时失败不闪错误，
 *   穷尽才呈现错误态，符合裁决语义）。
 */
import { getCurrentScope, onScopeDispose, readonly, ref, type Ref } from 'vue'

/** 自动重试次数上限（不含首载） */
export const LAZY_RETRY_LIMIT = 3

/** 退避基值（ms），第 n 次重试延迟 = BASE × n（300 / 600 / 900） */
export const LAZY_RETRY_BACKOFF_BASE_MS = 300

/**
 * 从装载失败错误中提取失败模块 URL（busting 重试的目标）。
 * 严格锚定 Chromium 原生错误前缀 `Failed to fetch dynamically imported module: <url>`
 * （探针实测，file:// dir 与 asar 同形；vite dev 同一浏览器原生格式）。前缀不匹配 → null：
 * 防误提取——vi.mock 工厂错误等非装载类错误的消息里可能含任意 URL（如实测的 vitest 文档
 * 链接 https://vitest.dev/...），误提取会让 busting 分支 import 无关 URL 永远失败。
 */
export function extractFailedModuleUrl(err: unknown): string | null {
  const msg = String((err as Error)?.message ?? '')
  const m = msg.match(/Failed to fetch dynamically imported module:?\s*((?:file|https?):\/\/[^\s'"`]+)/)
  return m ? m[1] : null
}

/**
 * 构造 busting URL：追加 `?t=N`（attempt 唯一 → module map key 唯一 → 强制重新加载）。
 * URL 已带 t 参数时替换其值（dev 下 HMR 时间戳 query 链）；已有其他 query 用 `&` 连接。
 * 纯函数，单测直连。
 */
export function withCacheBust(url: string, attempt: number): string {
  if (/[?&]t=\d+/.test(url)) return url.replace(/([?&])t=\d+/, `$1t=${attempt}`)
  return `${url}${url.includes('?') ? '&' : '?'}t=${attempt}`
}

/** busted import 注入缝：运行时形态是裸动态 import（vitest 无法按路径 stub 变量 URL），
 *  单测经 options.bustedImport 注入 spy 断言 busting 行为。 */
export type BustedImport = (url: string) => Promise<unknown>

const runtimeBustedImport: BustedImport = (url) =>
  import(/* @vite-ignore */ url)

export interface LazyChunkRetry<T = unknown> { // oe-exempt:20261003:framework:类型契约先行——重试状态机契约即测试消费面（状态机单测按此接口驱动），单实现为常态
  /** wrapper 重挂 key：每次自动重试自增（重试的唯一驱动，见头注「重试驱动形态」） */
  retryKey: Readonly<Ref<number>>
  /** 传给 defineAsyncComponent 的 loader（首载走静态 import，重试走 busted import） */
  loader: () => Promise<T>
  /** 传给 defineAsyncComponent 的 onError（内部计数/退避调度，穷尽 fail 呈现错误态） */
  onError: (err: unknown, retry: () => void, fail: () => void) => void
}

/**
 * 创建懒加载 chunk 的内部自动重试状态机（每挂载点一个实例，组件 setup 内调用）。
 *
 * 状态转换：
 * - fresh mount（抽屉/浮层重开等宿主 v-if 重挂，非 retryKey 驱动）→ 计数清零、bust 目标
 *   清空 = 新一轮——「关闭后重新打开」恒可获得全新的一轮自动重试（裁决的恢复出路）。
 *   判定 = expectRemount 标记（timer 触发时置位、被 retry() 同步触发的 loader 调用消费；
 *   其余 load 一律视为 fresh）。已知次要残留：重试退避期间关闭挂载点，后续轮次照常在
 *   背景推进（计数有界），穷尽 fail 时主动归零，重开恒全新一轮。
 * - 首载失败 → 提取失败 URL（busting 目标）→ onError 按 300ms×n 退避调度 userRetry +
 *   retryKey 重挂（双要素，见头注「重试驱动形态」）；重试的 import 走 busted URL
 *   （绕过 module map 记忆化）。
 * - 重试成功 → 计数清零；busted URL 因成功也已进 module map，后续同 URL 复用零请求。
 * - 穷尽（LIMIT 次）→ userFail() 呈现错误态（AsyncErrorFallback 文案带重试次数与恢复指引），
 *   同时状态归零（实装 setup catch 已清 pendingRequest，下一次 load 恒为全新一轮）。
 */
export function createLazyChunkRetry<T>(
  load: () => Promise<T>,
  options?: { bustedImport?: BustedImport },
): LazyChunkRetry<T> {
  const bustedImport = options?.bustedImport ?? runtimeBustedImport
  const retryKey = ref(0)
  let attempt = 0
  /** retryKey 重挂标记：timer 触发时置位，被 userRetry 同步触发的 loader 调用消费（保持
   *  计数）；其余 load（抽屉/浮层重开的 fresh mount）一律清零重开一轮。 */
  let expectRemount = false
  /** 首载失败时提取的 chunk URL（无 query；null = 提取不到，重试回落同 URL 机械路径） */
  let bustUrl: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const loader = () => {
    if (expectRemount) {
      expectRemount = false
    } else {
      attempt = 0
      bustUrl = null
    }
    if (bustUrl !== null) {
      // busting 重跑同一 chunk URL（?t=N 仅绕 module map 记忆化），模块形态与首载一致：
      // 运行时动态 import 类型上是 unknown，按同 chunk 语义收窄回 T（值形态由同一文件保证）。
      // 成功同样归零计数（与静态分支的 .then 同一归零语义，分写避免早退绕过）。
      return bustedImport(withCacheBust(bustUrl, attempt)).then((mod) => {
        attempt = 0
        return mod as T
      })
    }
    return load().then(
      (mod) => {
        attempt = 0
        return mod
      },
      (err) => {
        bustUrl = extractFailedModuleUrl(err)
        throw err
      },
    )
  }

  const onError = (err: unknown, retry: () => void, fail: () => void) => {
    void err
    if (attempt >= LAZY_RETRY_LIMIT) {
      // 穷尽：错误态呈现 + 状态归零（实装 setup catch 会清 pendingRequest，重开即全新一轮）
      attempt = 0
      bustUrl = null
      expectRemount = false
      fail()
      return
    }
    attempt++
    const userRetry = retry
    timer = setTimeout(() => {
      timer = null
      expectRemount = true
      // 双要素同调（头注「重试驱动形态」）：userRetry 清 pendingRequest 并同步重跑 loader
      // （本次失败的链在此结算，busted 重跑唯一跑点）；retryKey 重挂新 wrapper 接续同一链、
      // 结算时置 loaded。二者缺一会分别卡死在「链结算但 loaded 不置位」/「链恒 pending」。
      userRetry()
      retryKey.value++
    }, LAZY_RETRY_BACKOFF_BASE_MS * attempt)
  }

  // 宿主组件卸载后不再触发重试（timer 是唯一异步悬挂点；unmount 后 retryKey 写入无意义）。
  // 四处消费方均在组件 setup 内创建，scope 恒活跃。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (timer !== null) clearTimeout(timer)
    })
  }

  return { retryKey: readonly(retryKey), loader, onError }
}
