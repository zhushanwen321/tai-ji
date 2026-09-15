/**
 * useAppUpdate 的两阶段升级动作轴：performDownload（下载）/ performInstall（替换+重启）/
 * openFallbackUrl（不支持平台的备用下载页）。
 *
 * 错误双通路去重：onUpdateError 为 SSOT（subscribeProgress 已置 errorHandled=true 时），
 * catch 仅在 !errorHandled 时兜底置 error（避免覆盖更精确的 onUpdateError 信息）。
 *
 * 依赖方向：本模块 → use-app-update-state（读改 updateState + errorHandled flag）。
 * 被 useAppUpdate.ts 消费（进生产返回对象）。
 */
import {
  updateDownload as ipcUpdateDownload,
  updateInstall as ipcUpdateInstall,
  openUpdateFallbackUrl as ipcOpenUpdateFallbackUrl,
} from '@/api/domains/settings'
import { updateFlags, updateState } from './use-app-update-state'

/**
 * 执行下载阶段。state='downloading' + errorHandled=false，调 ipc.updateDownload。
 * downloaded=true → state='downloaded'（产物已下载并校验通过，等待 performInstall 触发替换重启）。
 * 下载止于 downloaded，不触发替换/重启（那是 performInstall 的职责）。
 * catch：!errorHandled 时兜底置 error（onUpdateError 已处理则不覆盖）。
 */
export async function performDownload(): Promise<void> {
  const release = updateState.latestRelease
  if (!release) return
  updateState.state = 'downloading'
  updateState.percent = 0
  updateState.errorMessage = ''
  updateFlags.errorHandled = false
  try {
    // [批次 3 RC1] 只传意图：version 字符串经 IPC，release 数据由 main 权威解析
    // （resolveByVersion 缓存/force check）。旧契约传完整 release 对象（含 toRaw 解包
    // proxy 的历史问题）随版本号化一并消失——字符串天然可 structured clone。
    const result = await ipcUpdateDownload(release.version)
    if (result.downloaded) {
      updateState.state = 'downloaded'
    }
  } catch (e) {
    // 去重：onUpdateError 已置 errorHandled=true 则不覆盖（SSOT 优先）
    if (!updateFlags.errorHandled) {
      updateState.state = 'error'
      updateState.errorMessage = e instanceof Error ? e.message : String(e)
      // 兜底错误不携带 suggestion，清掉上一次错误遗留的陈旧恢复指引
      updateState.errorSuggestion = ''
    }
  }
}

/**
 * 执行安装阶段（替换 + 重启）。依赖已下载产物（performDownload 成功后调用）。
 * 乐观置 replacing（漏洞6修复）：IPC 往返延迟内 state 立即变 replacing，堵二次点击竞态。
 * triggerRestart=true → state='restarting'（main 即将退出重启），且按响应 version
 * （实装权威）对齐 latestRelease 版本显示（D2 交错缓解，见函数内注释）。
 * catch：!errorHandled 时兜底置 error（onUpdateError 已处理则不覆盖）。
 */
export async function performInstall(): Promise<void> {
  // 乐观置 replacing（漏洞6修复）：IPC 往返延迟内 state 立即变 replacing，堵二次点击竞态
  updateState.state = 'replacing'
  updateFlags.errorHandled = false
  try {
    const result = await ipcUpdateInstall()
    if (result.triggerRestart) {
      // D2 交错缓解：手动认领与后台预下载并发写 preloaded（最后写者胜）时，实装版本
      // 可能新于 UI 确认版本（认领 0.9.11 → 预下载 0.9.12 覆写）。以 install 响应的
      // version（实装权威）对齐 latestRelease 版本显示；其他字段保持（app 即将重启，
      // 旧 release 的 notes/url 残留生命周期以秒计，整体替换无收益反而放大覆盖面）。
      if (
        result.version &&
        updateState.latestRelease &&
        result.version !== updateState.latestRelease.version
      ) {
        console.log(
          `[useAppUpdate] installed version ${result.version} differs from displayed ${updateState.latestRelease.version}, aligning display`,
        )
        updateState.latestRelease = { ...updateState.latestRelease, version: result.version }
      }
      updateState.state = 'restarting'
    } else if (!updateFlags.errorHandled) {
      // 未触发重启且无错误 → 复位（极少见，install 无 triggerRestart 通常伴随 error 事件）
      updateState.state = 'idle'
    }
  } catch (e) {
    if (!updateFlags.errorHandled) {
      updateState.state = 'error'
      updateState.errorMessage = e instanceof Error ? e.message : String(e)
      // 兜底错误不携带 suggestion，清掉上一次错误遗留的陈旧恢复指引
      updateState.errorSuggestion = ''
    }
  }
}

/** 不支持当前平台时，打开备用下载页（release 页面） */
export async function openFallbackUrl(): Promise<void> {
  const release = updateState.latestRelease
  if (!release) return
  await ipcOpenUpdateFallbackUrl(release.htmlUrl)
}
