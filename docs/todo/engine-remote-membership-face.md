# TODO：zcode 远程形态偏好层成员校验面（async listModels 经引擎进程 RPC）

## 状态

拆分登记（2026-10-16 真机测试后改写；同日 headersApplied 项已由 ADR-0139 关闭）：①枚举面缺口未解决（本登记唯一未决主体）；②GLM plan 通道 headersApplied 已关闭——根因 = taiji headless spawn 恒落 host-account 模式（非 ZCode.app 自身 bug，当日初判「ZCode 自身 bug」已作废，见文末附录），ADR-0139 standalone 补丁 + 元数据键供给真机验证通过。前提修复已落地：ADR-0138 补齐 RemoteEngine `translateModelRef`（manifest 声明表快照）+ 引擎侧 account 直通大小写归一。

## 问题

ADR-0137 的偏好层降级语义（engineDefaults 翻译后不在引擎清单 → 跳过偏好走引擎缺省 + warn）依赖 `EnginePort.listModels()` 提供成员校验清单。远程形态（staged 引擎 cli descriptor → RemoteEngine 代理）的 `listModels()` 只读 manifest 注册期静态快照，而 zcode 声明 `modelCatalog: {dynamic: true, models: []}` → 四态映射返回 null = 「无枚举面」→ `resolveEngineModelWithTranslation` 的成员校验放行。

后果：engineDefaults 里存了失效值（provider 被删/退役/拼写漂移）时，远程形态不会降级，偏好值直穿引擎侧首败报错（`model_not_available` + 恢复指引）。2026-10-16 实际事故中本机毒值 `zai-coding-plan/GLM-5.3-Flash` 已被用户裁决的新缺省覆盖，但**通用防护**仅在「有枚举面的引擎/形态」达成。

## 为什么当时不修

async listModels（经引擎进程 RPC 取实时清单）需要：EnginePort 签名变更（sync → `| Promise`）+ 引擎协议新增方法（protocol/SDK/engine-server 三面）+ engine-development-guide 协议契约同步——改动面数倍于本次修复，且派发身份解析期引入引擎进程首启延迟（shared-service 单例约一次性数百 ms）。按「最小修复 + 显式登记边界」取舍（ADR-0138 边界段）。

## 修复方向（裁决后实施）

1. 引擎协议新增 listModels 查询方法（或复用 probe 应答捎带清单），RemoteEngine.listModels 改 async RPC，zcode 引擎进程内实装已有 `listZcodeModels`（合并视图实时枚举，零额外成本）。
2. `resolveEngineModelWithTranslation` 成员校验改 await。
3. engine-development-guide 协议面文档同 commit 更新（协议方法语义 + capability 声明）。
4. 届时 ADR-0137 偏好层降级语义在全部部署形态达成，ADR-0138 边界段随之改写。

## 附录：GLM plan 通道 headersApplied（2026-10-16 真机 A/B 对照；已由 ADR-0139 关闭，根因见文末结论）

真机（staged 引擎 + 独立 pi，ADR-0138 修复后代码）：

| 用例 | 模型 | 解析/翻译 | 运行终态 |
|---|---|---|---|
| 显式 pi 词汇 | `zai-coding-cn/glm-5.3-flash` | ✓ 翻译到 `account:zai-individual-coding-plan/glm-5.3-flash`（record 盖章） | ❌ app-server `model_request_failed / invalid_union headersApplied` |
| 对照：个人 provider | `e512d53e-…/mimo-v2.6-flash` | ✓ | ✅ completed，输出 "ok" |
| 偏好路径（缺省） | engineDefaults（省略 model） | ✓ 同上翻译+盖章 | ❌ 同 headersApplied |

结论（2026-10-16 晚修正，源码实证取代当日推测）：taiji 修复链全通；`headersApplied` 与通道映射、凭据都无关——根因是 **taiji 的 headless spawn 恒落在 host-account 模式（源码协议路径不传 standalone），该模式需要宿主任应答 providerRuntimeHeaders 协议而 taiji 链上无宿主实现**。修复路径 = 让 app-server 跑 standalone 账号模式（补丁已实装，见 ADR-0139）；剩余前置 = credentials.json 的 standalone 设置键（identity/auth-source，见 ADR-0139 裁决项）。原文「ZCode 自身 bug」结论作废。
