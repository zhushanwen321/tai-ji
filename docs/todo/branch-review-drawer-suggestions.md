# branch-review drawer 分支建议级残余（随分支带走）

来源：dev-merge 合入点横切审查（feat-drawer-visualization-refactor → dev-0.10.12，2026-10-04，run 记录 `.tmp/dev-merge-review/dmg-fd656a759/`）。质量门全绿，必修（critical/major）经 2 轮审查修复循环全部收敛；以下 4 条建议级（minor）按流程随分支带走，不阻塞合并，待后续排期。各条完整证据链见 run 目录 ledger.json。

## 1. pi-host.ts 四字段 pi 上游断言缺 C-pi-02 锚点登记

- 现状：`extensions/universal/subagent-workflow/src/host/pi-host.ts:113-114` 写入「pi 上游 manifest 只有 extensions/skills/prompts/themes 四字段」的行为断言，docs/pi-semantics.json 无对应登记条目；断言内容已实测属实（0.84.4 dist/core/pi-manifest.js:3 `RESOURCE_FIELDS`），缺的是锚点登记——pi 升级后该断言不随版本门禁重验。同义事实在 `docs/extensions/extension-conventions.md:253` 已有 readPiManifest 锚点登记未被引用。
- 实现要点：注释改为引用 extension-conventions.md:253 的同源登记，或按 C-pi-02 补 docs/pi-semantics.json 条目（锚点 = RESOURCE_FIELDS + 版本号）；不愿维护该断言则删去对照句、只留 taiji 侧事实（仓内无包声明 pi.agents/pi.workflows + 权威源 = resource-discovery.ts processPackage）。

## 2. fileTree per-session 分区（含 diff 内容本体）无 data-source-registry.md 主表条目

- 现状：`packages/renderer/src/stores/fileTree.ts:339-344` 的 per-session detailTabs 分区持有文件内容/diff 内容本体，[data-source-registry.md](../architecture/data-source-registry.md) 无该域主表条目（§4 ⑧ 补登只覆盖 useDetailPane 技术簿记 loadTokens/pendingLoads）；对照 #36（plan 审阅态本体入主表）/ #13（trace entries）先例，持有内容本体的分区应有主表条目。同域 6 个兄弟分区（tree/expandedPaths/nodeStates/gitOverlay/dirChangeCounts/selectedPaths）共用同一口径歧义。
- 实现要点：为 fileTree 域补主表条目（权威源 = workspace 磁盘文件经 runtime file RPC，分区即拉取缓存，detailTabs 与同域 6 分区一并登记）；或在 §4 ⑧ 显式声明该域「纯 RPC 拉取视图缓存，不设主表条目」的口径及理由。

## 3. data-source-registry.md #47 写入口列缺 kill 通道类失败重建路径

- 现状：#47 写入口列枚举「terminal.spawn ack 建档 + terminal.list 对账 + 关闭沿释放三路径」，缺 kill 通道类失败的镜像重建路径——`packages/renderer/src/composables/useTerminal.ts` handleRoutingError kill 分档已实装「非 unknown_terminal_id 失败 → console.warn + toast + `establishInstance(terminalId,{alive:true})` 镜像重建」（代码注释与 i18n 双语文案已登记），治理登记 SSOT 缺该子句。
- 实现要点：#47 行写入口列补一句「kill 通道类失败 → establishInstance 原语重建镜像条目」，与 useTerminal.ts 既有代码注释同 commit 同步（行为代码已实装，本条只补登记文本）。

## 4. AppShell.vue 懒加载重试注释「单通道」表述与 lazy-chunk-retry.ts 双要素实装矛盾

- 现状：`packages/renderer/src/components/shell/AppShell.vue:65-68` 注释称重试由 retryKey 重挂「单通道」驱动，而 `packages/renderer/src/components/ui/lazy-chunk-retry.ts:155-159` 实装是 `userRetry()` + `retryKey.value++` 双要素同调（缺一分别卡死在链恒 pending / loaded 不置位）；两段注释同 commit 98877f16d 引入且互相否定，维护者按 AppShell 注释删 `userRetry()` 会导致 wrapper 恒停 loading。
- 实现要点：AppShell.vue 注释改写为与 lazy-chunk-retry.ts 头注一致的双要素表述，或删去机制描述只留指向头注的指针——同一机制只保留一份描述（lazy-chunk-retry.ts 本体不改）。
