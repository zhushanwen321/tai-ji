# 目录投喂的 models.json 可见性边界（已接受，provider-catalog-sync D6）

状态：已接受边界（2026-10-20 u-acceptance 真机核对登记；未发现真实使用，不立项一阶段修法）

设计源：provider-catalog-sync 设计 §3.3 D6「models.json 层的可见性边界」；销号记录 =
`provider-catalog-sync.acceptance/checkpoints.md` 检查点 3。

## 边界内容

pi 注册表的 extension 层是**映射替换**语义（`dist/core/provider-composer.js:171-177`
`applyExtension` 的 `config.models.map(...)`，map 替换而非 concat）——目录投喂注入的 models
数组就是该 provider 的最终可见集合。因此：**用户在 `models.json` 里给某个 catalog provider
手写的自定义模型，在该 provider 被目录投喂注入后会从视图中被挤出**（注入集不含它）。

## 为什么接受（低频 × 有手册路径 × 修法语义代价不成比例）

- **触发条件苛刻**：要求用户手编 `models.json` 给 catalog provider 添加自定义模型。taiji
  界面的「自定义模型」写的是独立自建 provider（不经 catalog provider 路径），8 个同根因
  症状也不含此场景。
- **有手册恢复路径**：删掉手写条目即恢复，无数据损失、无不可逆后果。
- **一阶段修法有真实语义代价**：避免挤出不需要读注册表完整并集——`models.json` 是磁盘
  文件，扩展工厂期可直接读该 provider 条目并入注入集。但代价是 extension 层开始承载用户
  配置的副本：注入集内含 models.json 层内容的物化拷贝，用户改 models.json 后须靠
  `refreshModels` 钩子同步重读维持一致（钩子输入从两份缓存扩为三份文件，逻辑与测试范围同步
  膨胀）。这与设计 §3.2 拒绝「物化进 models.json」同族——机器维护的数据与用户配置区的边界
  应保持在单一位置，机器通道不该复制用户配置内容。

## 真机核对结论（2026-10-20）

本机唯一 pi agent 目录的 `models.json` 仅两个 provider 条目：`StepFun` 与 `OpenDesign`。
以 pi-ai 官方导出 `getBuiltinProviders()`（42 个 provider id）逐条比对，**两者均不在内置
目录清单内**，都是独立自建 provider——正是 taiji 界面「自定义模型」写入的形态，不经
catalog provider 路径。无任何 catalog provider 的 models.json 手写条目。

→ **未发现真实使用**，按设计预留路径①登记接受边界，不立项一阶段修法。

## 复审/立项条件

若日后发现该场景真实存在（用户手编 models.json 给 catalog provider 加自定义模型并反馈
模型消失），按设计预留路径立项一阶段修法：工厂期读 models.json 合并注入集 + 钩子输入扩为
三份文件（含语义代价评估）。
