# TODO：zcode 远程形态偏好层成员校验面（async listModels 经引擎进程 RPC）

## 状态

未解决（2026-10-16 登记）。前提修复已落地：ADR-0138 补齐 RemoteEngine `translateModelRef`（manifest 声明表快照），但**枚举面缺口仍在**——本登记是它的后续项。

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
