/**
 * QuotaConfigureModule 测试桩工厂 —— ui 侧 settings 测试共用（C1 seam 的测试适配面）。
 *
 * 背景：CodingPlanSection 经 QUOTA_CONFIGURE_MODULE_KEY 直接持有 quota configure module
 * （SSOT：packages/core/src/domain/settings/quota-configure-module.ts）。本工厂的唯一目的：
 * 把「契约漂移」变成编译错误——返回对象带 QuotaConfigureModule 类型标注，契约新增 / 改名 /
 * 删除成员时此处立即报错。
 *
 * 默认态 = 「已选 api-key 类类型且齐备」的常规态（对齐 CodingPlanSection 用例的默认诉求），
 * 用例按需直接改 `view.value.*` / `draft.value.*`（桩是普通 ref，写入即生效）；
 * 写动作是 vi.fn（默认 noop），需要断言的用例经 mock.calls 检查。
 */
import { ref } from 'vue'
import { vi } from 'vitest'
import type {
  QuotaConfigureModule,
  QuotaDraftInput,
  QuotaSectionView,
  QuotaTestView,
} from '@taiji/core'

/** 构造 QuotaConfigureModule 桩：默认态 = 已选 zhipu（api-key 类）/ 齐备 / 测试空闲。 */
export function makeQuotaModuleStub(): QuotaConfigureModule {
  const draft = ref<QuotaDraftInput>({
    cookie: '',
    apiKey: '',
    credentialSource: 'provider',
    workspace: '',
  })
  const view = ref<QuotaSectionView>({
    type: {
      selected: 'zhipu',
      options: [],
      undetermined: false,
    },
    enabled: true,
    configuring: false,
    configureError: '',
    readiness: { ready: true, missing: [] },
    credential: {
      form: 'apiKey',
      exclusiveApplicable: true,
      providerAvailable: true,
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
