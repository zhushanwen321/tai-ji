/**
 * QuotaConfigureState（契约 v2）测试桩工厂 —— settings 相关测试共用。
 *
 * 背景：ProviderEditBody / CodingPlanSection 经 USE_QUOTA_CONFIGURE_KEY 注入消费
 * QuotaConfigureState（SSOT：packages/core/src/domain/settings/quota-configure-state.ts）。
 * 各测试文件曾各自内联 v1 契约字面量（apiKeyConfigured / toggleEnabled / selectFetcher /
 * saveCookie / saveApiKey / saveWorkspace / testQuery），契约升 v2 后未跟随；注入点是
 * `Record<any, any>`，`[KEY as symbol]` 强转又绕开 InjectionKey 的类型校验——vue-tsc 全绿，
 * 直到用例真正渲染 provider 编辑体才以 TypeError 暴露。
 *
 * 本工厂的唯一目的：把「契约漂移」变成编译错误。返回对象带 QuotaConfigureState 类型标注，
 * 契约新增 / 改名 / 删除成员时此处立即报错（即本问题要建立的守门）。所有成员给安全默认值，
 * 用例经 overrides 覆写自己关心的成员，未覆盖成员保持默认语义。
 */
import { ref } from 'vue'
import { vi } from 'vitest'
import type {
  NormalizedQuotaRow,
  QuotaAuthKind,
  QuotaCredentialSource,
  QuotaFetchFailureReason,
} from '@taiji/shared'
import type { QuotaConfigureState, QuotaTestStatus, ReadinessMissing } from '@taiji/core'

/** 构造 v2 齐备 QuotaConfigureState 桩：默认态 = 未选类型 / 未配置 / 空闲。 */
export function makeQuotaStateStub(
  overrides?: Partial<QuotaConfigureState>,
): QuotaConfigureState {
  const base: QuotaConfigureState = {
    fetcherId: ref<string | undefined>(undefined),
    fetcherOptions: [],
    enabled: ref(false),
    cookieInput: ref(''),
    apiKeyInput: ref(''),
    credentialSource: ref<QuotaCredentialSource>('provider'),
    providerCredentialAvailable: ref(false),
    quotaApiKeyConfigured: ref(false),
    providerCredentialPendingSave: ref(false),
    workspaceInput: ref(''),
    workspaceConfigured: ref(false),
    needsWorkspace: ref(false),
    readiness: ref<{ ready: boolean; missing: ReadinessMissing[] }>({ ready: false, missing: [] }),
    testStatus: ref<QuotaTestStatus>('idle'),
    testError: ref(''),
    quotaData: ref<NormalizedQuotaRow | null>(null),
    lastFetchAt: ref<number | null>(null),
    isCookieAuth: ref(false),
    authKinds: ref<readonly QuotaAuthKind[]>([]),
    testFailReason: ref<QuotaFetchFailureReason | null>(null),
    helpUrl: ref<string | undefined>(undefined),
    helpText: ref<string | undefined>(undefined),
    configuring: ref(false),
    configureError: ref(''),
    // 动作成员用 vi.fn：默认 noop，需要断言的用例可经 overrides 取回 spy 检查调用。
    setEnabled: vi.fn(async (_v: boolean) => {}),
    saveAndTest: vi.fn(async () => {}),
    reset: vi.fn(),
  }
  return overrides ? { ...base, ...overrides } : base
}
