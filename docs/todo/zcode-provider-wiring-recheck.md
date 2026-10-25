# zcode 引擎 Provider Registry / reasoningLevel 接线真机复验

状态：代码已落地（2026-09-29），剩真机复验。来源：subagent-workflow 体系登记 §6.2（原文见该文件 git 历史）。

## 根因定案（bundle 解剖 + 活体探针对拍，已核实）

app 3.14.x 起 plan 家族 provider 全部 `access=zhipu-account`（entitlement 门控），CLI 自举 fail-closed——外部 spawn 形态只有 `~/.zcode/v2/provider_config.json` 个人 provider 可装载，plan 家族 id 一律 provider-not-found（报错文案误导性写「不存在 Model」）；GUI 正常因其宿主有完整 env 配方 + 账号供数链；裸起崩溃是 CLI 相对路径推导算到根目录，launcher 目录注入是外部 spawn 启动前提。

## 已落地

- preparer.ts 模型源切换 provider_config.json / 缺席模型返回空串走 CLI 缺省；
- ZCODE_FALLBACK_DEFAULT_MODEL 常量双侧删除；ZCODE_BASE_URL 注入；
- reasoningLevel 最小档解析经 create 帧 options 自动补档；包全量单测绿。

## 待做

- 真机复验：zcode 修复整体收尾后随 a1a4 复跑（剧本成员模型已钉注册表内快档 mimo-v2.6-flash）。

## 关联

- 引擎默认 provider/model 设置长期登记：原 engine-default-provider-setting.md（已随设置交付销账删除，git 历史可追溯）。
