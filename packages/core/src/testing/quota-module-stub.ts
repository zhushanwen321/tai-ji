/**
 * QuotaConfigureModule 测试桩工厂（quota seam 收编后的测试适配面，core/renderer/ui 测试共用单源）。
 *
 * 背景：ui 侧 CodingPlanSection 经 QUOTA_CONFIGURE_MODULE_KEY 直接持有 quota configure module；
 * renderer 壳经 QUOTA_CONFIGURE_FACTORY_KEY provide module 实现工厂，ProviderEditBody 物化实例后
 * 交 CodingPlanSection 消费（SSOT：packages/core/src/domain/settings/quota-configure-module.ts）。
 * 本工厂的唯一目的：把「契约漂移」变成编译错误——返回对象带 QuotaConfigureModule 类型标注，
 * 契约新增 / 改名 / 删除成员时此处立即报错。
 *
 * 预设默认态按 state 二选一（对齐两类用例的原生默认诉求，用例零断言改动）：
 * - 'ready'：已选 zhipu（api-key 类）/ 齐备 / 测试空闲（ui settings 用例默认）；
 * - 'empty'（缺省）：未选类型 / 未配置 / 空闲（renderer 壳用例默认）。
 * 用例按需直接改 `view.value.*` / `draft.value.*`（桩是普通 ref，写入即生效）；
 * 写动作是 vi.fn（默认 noop），需要断言的用例经 mock.calls 检查。
 *
 * 导出面：@taiji/core/testing（与 makeSettingsTransportStub 同址同范式）。
 */
import { ref } from 'vue'
import { vi } from 'vitest'
import type {
  QuotaConfigureModule,
  QuotaDraftInput,
  QuotaSectionView,
  QuotaTestView,
} from '../domain/settings/quota-configure-module'

/** 桩的预设默认态：'ready' = 已选类型且齐备；'empty' = 未选类型 / 未配置。 */
export type QuotaModuleStubState = 'ready' | 'empty'

/** 'ready' 预设视图：已选 zhipu（api-key 类）/ 齐备 / 测试空闲（ui settings 用例默认）。 */
function readyView(): QuotaSectionView {
  return {
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
  }
}

/** 'empty' 预设视图：未选类型 / 未配置 / 空闲（renderer 壳用例默认）。 */
function emptyView(): QuotaSectionView {
  return {
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
  }
}

/** 构造 QuotaConfigureModule 桩：state 选预设默认态（缺省 'empty'）。 */
export function makeQuotaModuleStub({
  state = 'empty',
}: { state?: QuotaModuleStubState } = {}): QuotaConfigureModule {
  const draft = ref<QuotaDraftInput>({
    cookie: '',
    apiKey: '',
    credentialSource: 'provider',
    workspace: '',
  })
  // 消费方存在 view.value.readiness = ... / view.value.configuring = true 的属性级写法
  // （如 coding-plan-section.test.ts），预设视图按调用构造独立副本防跨 stub 实例状态泄漏。
  const view = ref<QuotaSectionView>(state === 'ready' ? readyView() : emptyView())
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
