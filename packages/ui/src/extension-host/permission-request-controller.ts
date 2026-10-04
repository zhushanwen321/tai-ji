/**
 * permission-request-controller.ts —— 权限审批编排状态机 factory（双壳共享本体，
 * remote-use 架构审查裁决：两壳各写一份且已单侧漂移，下沉为单一实现）。
 *
 * 消息流：runtime 广播 plugin:permissionRequest → MessageBusBridge 归一 →
 * bus 'plugin-permission-request' → 本 factory 写 reactive state → 壳挂
 * PermissionRequestDialog（:plugin-id/:permissions/:pending/:error props）→
 * 用户作答 → transport（PermissionTransport 契约实现）→
 * plugin.approvePermissions / plugin.denyPermissions WS 命令（core plugin 域既有
 * 通路，零新协议）。
 *
 * 双壳接线（壳各自保留的装配裁决，不进本模块）：
 * - 桌面 renderer：usePermissionRequest.ts 薄接线（main.ts 挂载前 init +
 *   app.provide；bus 来源 getExtensionBus() 惰性单例；重复 init 幂等靠 dispose）
 * - 移动 mobile-renderer：shell/companion-bridge.ts 模块级 controller（bus 单例
 *   私居该模块；App.vue provide + 挂 Dialog）
 *
 * 状态机不变量（单测在同包 __tests__/permission-request-controller.test.ts 钉住）：
 * - 畸形事件守卫：pluginId 空 / permissions 非 string 数组 → warn + skip（不写坏
 *   state）；permissions 拷贝入 state（防外部数组后续变更串扰）
 * - 新请求覆盖旧弹窗（全局单例，一次一个，不做队列）：pluginId/permissions 全量
 *   重置 + error 清零（BM3 错误行只描述当前弹窗的提交结果）
 * - BM3 假成功红线：RPC reject 时 pending 保持 true（弹窗不关供重试）+ error=true
 *   显形错误行——catch 后静默关窗会被误读为「已送达」；提交入口乐观清错
 * - D3 超时撤窗：WS plugin:permissionRequestExpired（timeout-plugin-service 取消
 *   非判拒，payload 无 sessionId → global 通道直发，不经 bridge/bus）按 requestId
 *   精确匹配撤回（requestId 与本次审批 permissionRequest 广播同源）；payload 缺
 *   requestId（旧版广播）回退按 pluginId 匹配；陈旧广播（不匹配当前弹窗）noop，
 *   无挂起弹窗时 noop 幂等
 * - S5-V3 终局撤窗：bus 'plugin-permission-request-resolved'（runtime 在任一端
 *   批准/拒绝后广播 plugin:permissionRequestResolved，bridge 归一）按 requestId
 *   精确匹配撤回——同一审批的多连接端中非操作端据此撤回弹窗（操作端 RPC 收口先行
 *   置 pending=false，resolved 到达 noop 幂等）；requestId 空串（bridge 对旧版广播
 *   的宽容窄化产物）回退按 pluginId 匹配，兼容链与 expired 一致
 * - deny 语义 = 拒绝本次申请不清已授权限（plugin.denyPermissions，M7 语义）
 *
 * dispose：退订全部 bus/WS 订阅（桌面壳重复 init 幂等 / 测试隔离用）。
 */
import { reactive } from 'vue'
import type { InternalEventBus } from '@taiji/core'
import { onGlobal } from '@taiji/core/transport/api'
import * as pluginApi from '@taiji/core/transport/api/domains/plugin'
import type { PermissionTransport } from './permission-transport'

/** 审批弹窗可见状态（壳绑定 PermissionRequestDialog props）。 */
export interface PermissionRequestState {
  /** 申请权限的插件 id */
  pluginId: string
  /** 插件申请的权限列表（拷贝入 state，防外部数组后续变更串扰） */
  permissions: string[]
  /** 审批请求唯一标识（runtime 每次审批新生成；expired 广播按它精确撤回，弹窗 UI 不消费） */
  requestId: string
  /** 请求是否挂起（true=弹窗打开；RPC 回传成功后置 false；失败保持 true 供重试） */
  pending: boolean
  /** 上次提交是否失败（失败时弹窗内显形错误行；下次提交入口乐观清错，新请求到达清零） */
  error: boolean
}

/** 权限审批编排 controller（factory 产出，壳经 provide/导出接线消费）。 */
export interface PermissionRequestController {
  /** 弹窗状态（reactive 单例，本 controller 生命周期内同一引用） */
  state: PermissionRequestState
  /** RPC 回传通道（permission-transport.ts 契约实现，Dialog 经 inject 消费） */
  transport: PermissionTransport
  /** 退订全部订阅（重复装配幂等 / 测试隔离；调用后 state 停止更新） */
  dispose(): void
}

/**
 * 创建权限审批编排 controller：bus 订阅 + expired 撤窗订阅 + reactive state +
 * PermissionTransport 回传，全部状态机逻辑单点持有。
 *
 * sessionId 语义：runtime permissionRequest 广播 payload 协议性无 sessionId
 * （plugin-service onPermissionRequest 直发 activator payload），审批弹窗全局
 * 单例 session 无关——不做「无 sessionId 跳过」，只挡结构坏事件（warn + skip
 * 不崩）。
 */
export function createPermissionRequestController(bus: InternalEventBus): PermissionRequestController {
  const state = reactive<PermissionRequestState>({
    pluginId: '',
    permissions: [],
    requestId: '',
    pending: false,
    error: false,
  })

  // bus 订阅：新请求覆盖旧 state（一次一个，不做队列）；守卫 + 拷贝防写坏/串改
  const offRequest = bus.on('plugin-permission-request', (e) => {
    const req = e.request
    if (
      typeof req.pluginId !== 'string' ||
      req.pluginId === '' ||
      !Array.isArray(req.permissions) ||
      !req.permissions.every((p) => typeof p === 'string')
    ) {
      console.warn('[permission-controller] permission-request 事件畸形，跳过:', req)
      return
    }
    state.pluginId = req.pluginId
    state.permissions = [...req.permissions]
    state.requestId = req.requestId
    state.pending = true
    // 新请求覆盖旧弹窗：上一单的失败错误态不残留（错误行只描述当前弹窗的提交结果）
    state.error = false
  })

  // 超时撤窗（timeout-plugin-service D3，取消非判拒）：payload 无 sessionId →
  // global 通道直发（不经 bridge/bus）。按 requestId 精确匹配撤回（与本次审批
  // permissionRequest 广播同源的唯一标识）：同 pluginId 前序审批的陈旧 expired
  // 广播不误撤后到弹窗；payload 缺 requestId（旧版 runtime 广播）回退按 pluginId
  // 匹配。均不匹配（无挂起弹窗 / 已换新请求）→ noop 幂等。
  const offExpired = onGlobal((msg) => {
    if (msg.type !== 'plugin:permissionRequestExpired') return
    const payload = msg.payload as { pluginId?: unknown; requestId?: unknown }
    if (typeof payload.pluginId !== 'string') return
    const expiredRequestId = typeof payload.requestId === 'string' ? payload.requestId : ''
    const matches = expiredRequestId !== ''
      ? state.pending && state.requestId === expiredRequestId
      : state.pending && state.pluginId === payload.pluginId
    if (matches) {
      state.pending = false
      state.error = false
    }
  })

  // 终局撤窗（remote-use-mobile S5-V3）：任一端批准/拒绝后 runtime 广播
  // plugin:permissionRequestResolved，bridge 归一为本 bus 事件。匹配兼容链与 expired
  // 同构（requestId 精确 → 缺失回退 pluginId）：本端已由 RPC 收口置 pending=false
  // （操作端），resolved 到达 noop 幂等；非操作端命中即撤（弹窗对应请求已终局，
  // 继续作答只会得到 runtime 迟到审批 miss——UI 先行撤回与后端终局一致）。
  const offResolved = bus.on('plugin-permission-request-resolved', (e) => {
    const r = e.resolved
    if (typeof r.pluginId !== 'string' || typeof r.approved !== 'boolean') {
      console.warn('[permission-controller] permission-request-resolved 事件畸形，跳过:', r)
      return
    }
    const matches = r.requestId !== ''
      ? state.pending && state.requestId === r.requestId
      : state.pending && state.pluginId === r.pluginId
    if (matches) {
      state.pending = false
      state.error = false
    }
  })

  /**
   * RPC 收口（BM3 假成功红线）：入口乐观清错；成功 pending=false 关窗；失败
   * pending 保持 true（弹窗不关）+ error=true 显形错误行供重试。
   */
  function settlePending(promise: Promise<unknown>, op: string): void {
    state.error = false
    void promise
      .then(() => {
        state.pending = false
        state.error = false
      })
      .catch((err: unknown) => {
        console.warn(`[permission-controller] ${op} failed`, err)
        state.error = true
      })
  }

  const transport: PermissionTransport = {
    approve(pluginId: string, permissions: string[]): void {
      settlePending(pluginApi.approvePermissions(pluginId, permissions), 'approvePermissions')
    },
    deny(pluginId: string): void {
      settlePending(pluginApi.denyPermissions(pluginId), 'denyPermissions')
    },
  }

  return {
    state,
    transport,
    dispose(): void {
      offRequest()
      offExpired()
      offResolved()
    },
  }
}
