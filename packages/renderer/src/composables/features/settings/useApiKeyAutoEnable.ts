/**
 * useApiKeyAutoEnable —— provider 启用开关链路 + 「apikey 配置完成即自动启用」增强。
 *
 * 从 ProviderPage 收编 onToggleEnabled/toggling（wave4 C1 乐观更新 + 回滚链路原样搬迁，
 * 页面 template 解构同名不变），并叠加 afterApiKeySave：
 *
 * 背景：runtime 侧 setProvider 新建分支与 importer applyImport 已自动 ensureProviderInWhitelist
 * （新建/导入即启用）；唯一缺口是「编辑已存在但被禁用的 provider」——setProvider 编辑分支
 * 不动 enabledModels 白名单，用户重填 apikey 后仍需手动拨开关。
 *
 * 判定信号 = 本次保存是否写入非空 apiKey（save() 的 wroteApiKey / QuickSetup 的 data.apiKey），
 * 不用 ProviderInfo.authMethod 状态判定：编辑体新建未切形态的 provider authMethod 聚合为
 * undefined（严格判定漏「重填 key」主诉场景；放宽判定会误启存量无标注的 OAuth provider——
 * catalog 的 apiKeySet 含 auth.json OAuth 凭据无法区分）。oauth/ambient 形态保存不携带
 * apiKey，天然不触发；未来新增 provider 零代码（无清单）。
 *
 * no-op 边界：wroteApiKey=false（只改配置不动凭据/清除 key，尊重此前的禁用意图）；列表中
 * 无该 provider（新建，broadcast 未回——runtime ensure 已启用）；已启用（幂等）。
 */
import { ref } from 'vue'
import { config } from '@/api'
import { getSettingsStore } from '@taiji/core'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import type { ProviderInfo } from '@taiji/shared'

const t = i18n.global.t

export function useApiKeyAutoEnable(opts: {
  /** 当前 provider 列表读取器（ProviderPage props.providers 的 getter——enabled 旧值即真值：setProvider 编辑分支不改白名单） */
  providers: () => ProviderInfo[]
  /** 动作错误上报（写页面常驻 inline error，与删除/设默认共用） */
  setActionError: (msg: string) => void
}) {
  /** toggle 中的 provider id 集合（防双击） */
  const toggling = ref<Set<string>>(new Set())
  const settingsStore = getSettingsStore()
  const toast = useToast()

  /** 启用开关：乐观更新 store + config.toggleProviderEnabled 持久化（wave4 C1），失败回滚。返回是否成功 */
  async function onToggleEnabled(p: ProviderInfo, enabled: boolean): Promise<boolean> {
    if (toggling.value.has(p.id)) return false
    opts.setActionError('')
    const next = new Set(toggling.value)
    next.add(p.id)
    toggling.value = next
    const old = settingsStore.setProviderEnabled(p.id, enabled)
    try {
      // wave4：走 toggleProviderEnabled（写 enabledModels 白名单）。旧 setProvider({enabled})
      // 在 wave3 停用 provider 级 enabled 写入后无效。newDefault 经 onDefaults 订阅推回。
      await config.toggleProviderEnabled(p.id, enabled)
      if (!enabled && settingsStore.defaultModel.value.startsWith(`${p.id}/`)) {
        settingsStore.defaultModel.value = ''
      }
      return true
    } catch (e) {
      settingsStore.setProviderEnabled(p.id, old)
      const msg = e instanceof Error ? e.message : String(e)
      opts.setActionError(msg)
      return false
    } finally {
      const after = new Set(toggling.value)
      after.delete(p.id)
      toggling.value = after
    }
  }

  /** 保存成功后：本次写入了非空 apiKey 且 provider 当前未启用 → 自动启用 + toast（复用手动开关链路） */
  async function afterApiKeySave(providerId: string, wroteApiKey: boolean): Promise<void> {
    if (!wroteApiKey) return
    const p = opts.providers().find(x => x.id === providerId)
    if (!p || p.enabled) return
    const ok = await onToggleEnabled(p, true)
    if (ok) toast.info(t('settings.provider.autoEnabledToast', { name: p.name }))
  }

  return { toggling, onToggleEnabled, afterApiKeySave }
}
