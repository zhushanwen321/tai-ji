/**
 * QuotaConfigureModule 测试桩工厂（renderer 侧 settings 测试共用，C1 seam 的测试适配面）。
 *
 * 背景：renderer 壳经 QUOTA_CONFIGURE_FACTORY_KEY provide module 实现工厂，ProviderEditBody
 * 物化实例后交 CodingPlanSection 消费（SSOT：packages/core/src/domain/settings/quota-configure-module.ts）。
 * 本工厂的唯一目的：把「契约漂移」变成编译错误——返回对象带 QuotaConfigureModule 类型标注，
 * 契约新增 / 改名 / 删除成员时此处立即报错。所有透镜给安全默认值（未选类型 / 未配置 / 空闲），
 * 用例按需直接改 `view.value.*` / `draft.value.*`（桩是普通 ref，写入即生效）。
 */
import { ref } from 'vue'
import { vi } from 'vitest'
import type {
  QuotaConfigureModule,
  QuotaDraftInput,
  QuotaSectionView,
  QuotaTestView,
} from '@taiji/core'

/** 构造 QuotaConfigureModule 桩：默认态 = 未选类型 / 未配置 / 空闲。 */
export function makeQuotaModuleStub(): QuotaConfigureModule {
  const draft = ref<QuotaDraftInput>({
    cookie: '',
    apiKey: '',
    credentialSource: 'provider',
    workspace: '',
  })
  const view = ref<QuotaSectionView>({
    type: {
      selected: undefined,
      options: [],
      undetermined: true,
    },
    enabled: false,
    configuring: false,
    configureError: '',
    readiness: { ready: false, missing: ['type'] },
    credential: {
      form: 'apiKey',
      exclusiveApplicable: false,
      providerAvailable: false,
      sourceHint: 'providerApiKey',
      providerWarning: null,
    },
    workspace: { required: false },
    help: null,
  })
  const test = ref<QuotaTestView>({
    status: 'idle',
    row: null,
    lastFetchAt: null,
    failure: null,
  })
  return {
    draft,
    view,
    test,
    selectType: vi.fn(),
    setEnabled: vi.fn(async (_next: boolean) => {}),
    saveAndTest: vi.fn(async () => {}),
  }
}
