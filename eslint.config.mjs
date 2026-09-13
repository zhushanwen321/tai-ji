import tasteConfig from './taste-lint/vue.mjs';

export default [
  ...tasteConfig,
  {
    ignores: [
      'src/dist/**',
      'src-tauri/**',
      'taste-lint/**',
      // 独立 CJS 验证脚本（verify-scheduler-e2e.cjs，随 tools→scripts 目录迁移更新路径）：
      // require() 是 CJS 唯一导入方式 + 内部 `_` 占位变量，no-require-imports/no-unused-vars 均误报
      'scripts/*.cjs',
      'vendor/**',
      '.pi/**',
      // 临时/历史 demo 目录（.tmp 已 gitignore，v6 是重构前的遗留 demo）
      '.tmp/**',
      // 构建产物（目录重构后：apps/electron + packages/*）
      'apps/electron/dist/**',
      'apps/electron/renderer/dist/**',
      'apps/electron/renderer/dist-new/**',
      'packages/*/dist/**',
      // subagent-core 本地 bundle 产物（untracked、gitignored，构建后不重排 lint 代码风格）
      'packages/*/dist.bundle/**',
      'apps/electron/preload/preload.js',
      'apps/electron/resources/pi/**',
      'apps/electron/resources/extensions/**',
      // [W11] 引擎包 staging 产物（bundle-extensions esbuild 输出，gitignored 构建产物）
      'apps/electron/resources/engines/**',
      // .xyz-harness 是设计文档/骨架代码（spec/plan/code-skeleton），非项目源码，不参与 lint
      '.xyz-harness/**',
      // playwright 测试产物（trace/报告是工具生成的压缩 JS，非项目源码，已被 .gitignore）
      'playwright-report/**',
      'playwright/.cache/**',
      'test-results/**',
      // vitest coverage 产物（工具生成的 JS，已被 .gitignore）
      '**/coverage/**',
      // pi extension 运行时脚本/示例（非 TS 源码，不参与 lint）。
      // ** 匹配分组层（extensions/taiji|universal/<pkg>/workflows/**，2026-08-22 分组
      // 后一层 * 不再命中，workflows/*.js 被误 lint 报 25 个 no-require-imports error）
      'extensions/**/workflows/**',
      'extensions/**/.pi/workflows/**',
      // [u1-move] 内置 workflow 脚本资产随 core 切面迁入 packages/subagent-core
      // （subagent-core 包抽离）：worker 脚本 require() 是 scriptPath 目录锚定机制
      // （设计 D1），src=dist 同字节直发不做 TS 化——同 extensions/**/workflows 先例豁免。
      'packages/subagent-core/workflows/**',
      'extensions/**/examples/**',
      // zsub/zflow workflow 脚本（.agents/workflows/*.js）：CJS 是 zflow 加载器契约
      // （module.exports + require，.cjs 后缀不被其发现层扫描），与根 package.json
      // type:module 的冲突由同目录 package.json {"type":"commonjs"} 解决；
      // no-require-imports 对其是误报（同 extensions/**/workflows/** 先例）
      '.agents/workflows/**',
      // skill 内置 workflow 脚本（pr-lifecycle 入口 + lib.cjs + node 直测 run-tests.js）：
      // CJS 是 workflow 加载器契约（同上），no-require-imports 对其是误报
      '.agents/skills/**/workflows/**',
    ],
  },
  // [HISTORICAL] mock 门面文件是所有 domain 的聚合中心（session/chat/config/model/extension/plugin/
  // settings/workspace/composer 共 9 个域），天然需要超 500 行。拆分到 per-domain 文件需要重构
  // 内部共享函数（pushSession/emit/sleep/fixtureSessions 等），收益不抵成本。fixture 数据已拆到
  // data.ts/settings-data.ts/composer-data.ts/workflow-data.ts。
  // [tc-transport-consolidation u3→u5] 文件已迁 core（原 packages/renderer/src/api/mock/index.ts），
  // 豁免 glob 跟随真源路径。
  {
    files: ['packages/core/src/transport/mock/index.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] runtime 的 .cjs 文件（plugin-esm-loader.cjs 等）是 Node CJS 模块，
  // require() 是唯一导入方式——no-require-imports 规则对 .cjs 是误报（2026-08-05 添加，
  // sandbox ESM loader 落地时确认：tsup entry 直接打包 .cjs 源文件，无 TS 转换层）。
  {
    files: ['packages/runtime/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  // [HISTORICAL] runtime 核心服务聚合点：event-adapter（pi 事件→前端消息的唯一适配层）、
  // extension-service（扩展生命周期 + 路径解析 + 热重载）。二者都是本子系统的唯一聚合
  // 中心，职责内聚但行数超 500，拆分属独立重构任务（event-adapter 归 C2 候选收尾）。
  // 短期 max-lines override 避免阻塞，长期应拆分。
  // [HISTORICAL] session-service 曾在本清单（session 生命周期/历史/fork/agentcall 的
  // facade），2026-09 session-service-deepening 六域迁出后移除（S6/D5：行数守卫恢复，
  // 设计 docs/design/session-service-deepening.md）。
  {
    files: [
      'packages/runtime/src/infra/pi/event-adapter.ts',
      'packages/runtime/src/services/extension-service.ts',
      // [HISTORICAL] core chat 域编排聚合点（createUseChat factory + 全部 stream 回调
      // 分支 helper——message.* 处理序的唯一编排面，2026-09-07 簇 A1 defer flush 重投
      // 机制入列时统计行越过 500）。职责内聚，拆分 = stream 回调按帧族重组，属独立
      // 重构任务。短期 max-lines override 避免阻塞，长期应拆分。
      'packages/core/src/domain/chat/useChat.ts',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL·2026-09 idle-pi-reclamation] 空闲 pi 进程回收功能接入（reaper 装配 +
  // 生命周期挂钩）：runtime index.ts 是进程组装 barrel，main 基线 501 行即超，本次 +41。
  // 拆分归独立重构单元（设计文档已删除，git 历史可追溯），
  // 禁止在 lint 收敛批次内拆文件重构。短期 max-lines override 避免阻塞。
  // [merge dev-0.9.17 2026-09] session-service.ts 已从本 off 块移除——config 末尾的
  // 软上限块（warn 650）语义更严且后位覆盖，双块并存 = 冲突；以末尾块为唯一权威。
  {
    files: [
      'packages/runtime/src/index.ts',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] 复杂度债务偿还（docs/design/complexity-debt-full-repayment.md）产物：
  // 以下文件因行为保持提取（helper 签名/花括号/JSDoc 开销）代码行超 max-lines 阈值。
  // 职责内聚（每文件均为单一子系统的高复杂度函数原地拆解，cyclo 已全部 ≤12），
  // 按行数再拆属独立重构任务。第一批：rpc-client / session-lifecycle / 两个
  // message-handler / session-reconstructor；第二批：download-asset。
  {
    files: [
      'packages/runtime/src/infra/pi/rpc-client.ts',
      'packages/runtime/src/services/session/session-lifecycle.ts',
      'packages/runtime/src/transport/session-message-handler.ts',
      'packages/runtime/src/transport/settings-message-handler.ts',
      'packages/subagent-core/src/execution/session-reconstructor.ts',
      // [HISTORICAL] message-dispatcher 是消息派发职责的唯一聚合点（从 session-service
      // 巨石拆出：sendMessage/abort/steer/followUp/compact + sendBash 家族），2026-09-09
      // chat-domain-v1x-liveness-governance W7 abort 超时三级阶梯（handleAbortRpcTimeout/
      // runAbortStallLadder/probeEngineAlive）入列时净代码行越过 500。职责内聚（abort
      // 超时处置归 abort() 所在文件），阶梯抽独立文件需引入新的模块边界与构造注入面，
      // 属独立重构任务。短期 max-lines override 避免阻塞，长期应拆分。
      'packages/runtime/src/services/session/message-dispatcher.ts',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] renderer markdown 渲染唯一适配层：markdown-it 配置 + fence 规则覆盖 +
  // filepath core rule + KaTeX + segments 拆分 + D-5 增量渲染（findStableBoundary/
  // renderIncremental，2026-08-16 W22 落地）。职责内聚（都消费同一 markdown-it 单例与
  // MarkdownSegment 协议），行数超 500。拆分需先定增量协议归属（W23 消费方对接后），
  // 属独立重构任务。短期 max-lines override 避免阻塞，长期应拆分。
  {
    files: ['packages/renderer/src/composables/logic/markdown.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] i18n locale 文件是翻译数据表（纯 key→文案映射，无逻辑），按功能 key
  // 线性增长——行数随功能面扩大是常态而非坏味道，500 行上限针对的是逻辑文件的可读性，
  // 对数据表不适用（2026-09-06 background-task-sidebar 的 panel 文案并入触发超行）。
  // 拆分反而破坏 per-locale 单文件契约（check_i18n_locale_sync 按 zh-CN/en-US 同名文件
  // 配对校验）。与上方 override 同性质——数据聚合文件，行数守卫豁免。
  {
    files: ['packages/renderer/src/i18n/locales/**/*.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] protocol.ts 是全 WS 协议的 SSOT（ClientMessageType/ServerMessageType/
  // ClientMessageMap/ServerMessageMap/ReplyPayloadMap + 各域 Config/ErrorCode 类型）。
  // 所有 type 相互交叉引用（ClientMessage<T> 依赖 ClientMessageMap，后者引用所有 payload 类型），
  // 拆分到 per-domain 文件需要重新设计模块边界（如把 ReplyPayloadMap 的 key 列表与 ClientMessageType
  // 解耦），属独立重构任务。与上方 4 个 override 同性质——唯一聚合中心，行数超 500。
  {
    files: ['packages/shared/src/protocol.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] trigger-evaluator.ts 是重审触发条件的唯一目录 SSOT（crash-forensics-and-watchdog
  // 设计 D2 + 附录 A 20 条）：条件清单、窗口谓词、各条评估逻辑共享同一状态表类型与
  // inWindow/coverage 降权辅助——拆成多文件会把「20 条一一对应」的可核验性（测试按 id 全量断言）
  // 变成跨文件分散，属独立重构任务。2026-09-11 交付时 539 行超 500。
  {
    files: ['apps/electron/main/diagnostics/trigger-evaluator.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] logger.ts 是 runtime 日志设施的唯一聚合点：主日志/pi tee/relay tee 三形态
  // writer（createPiStreamWriter 共享轮转，2026-09-11 u9 tee size 轮转）+ 内存水位打点与
  // 自然日聚合（2026-09-11 u1e watermark-daily）共用 pendingLines/流引用/轮转序同一套状态机。
  // 拆分需重新设计写者注册与 flush 生命周期，属独立重构任务；与 protocol.ts override 同型。
  {
    files: ['packages/runtime/src/infra/logger.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] session-channel.ts 是 zcode 单任务会话通道的唯一聚合点：A.2 协议帧序
  // SSOT（create/subscribe/send/终态双保险判定/read/close）+ P0-1 turn 等待两 timer
  // 状态机（idle 主判定 + 总上界兜底，timeout-zcode-turn-and-settled-watchdog.md §6 D1，
  // 2026-09-05 落地后超限）。职责内聚（帧序分发、终态判定与 idle 刷新共享同一
  // ActiveTurn 状态），行数超 500。拆分违反该设计 §7「无新模块」约束，属独立重构任务。
  // 与 event-adapter/session-service 等 override 同型——唯一聚合中心，短期避免阻塞。
  // [W11] session-channel.ts 随 zcode 引擎外移迁入 @zhushanwen/zcode-subagent-cli
  // （W5 整包搬移），override 路径同步跟随——搬移前后生效规则集 diff = 0（impl-plan
  // §2.11 eslint override 迁移验收）。
  {
    files: [
      'packages/zcode-subagent-cli/src/session-channel.ts',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
  // [H4 record 持久化收敛 / D7 守卫分级] store 外禁 import record 写面函数——
  // eslint no-restricted-imports 是模块边界一级拦截（新增写者在 import 面即报错），
  // grep 门（scripts/check-record-write-surface.mjs）降为文本级兜底（拦类方法调用
  // 与字面量写形态）。写面唯一入口 = RecordStore（packages/subagent-core/src/
  // execution/record-store.ts，豁免）；测试文件豁免（mock/替身形态非生产写面）。
  // 边界登记：manifest 写面是 ManifestStore 实例方法（writeManifest）——import 层
  // 拦不住（装配点构造合法），该面由 grep 门 R1 兜底；writeRecordBinding /
  // updateRecordBinding（UF-1 绑定 sidecar）不在 record 终态写面收敛范围，不拦。
  // barrel（packages/subagent-core/src/index.ts）零导出本组写函数，公开面不外泄。
  {
    files: ['packages/subagent-core/src/**/*.ts'],
    ignores: [
      'packages/subagent-core/src/execution/record-store.ts',
      'packages/subagent-core/src/**/__tests__/**',
      'packages/subagent-core/src/**/*.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/state-marker.ts'],
              // .state 三写函数全集（U2 后）：两终态（finalized/cancelled）+ 轮收口
              // idle（writeSettledState）——三者同走 writeStateMarker 权威同步写。
              importNames: ['writeFinalizedState', 'writeCancelledState', 'writeSettledState'],
              message:
                'store 外禁 import .state sidecar 写函数（两终态 + U2 轮收口 idle）——经 RecordStore.markFinalized/markCancelled/markSettled 意图原语落盘（H4/G1，D7 守卫分级）',
            },
            {
              group: ['**/alive-store.ts'],
              importNames: ['writeAliveMarker', 'removeAliveMarker'],
              message:
                'store 外禁 import .alive 写/删函数（跨进程写权声明）——acquire/release 归 RecordStore 意图原语内部（H4/G1，D7 守卫分级）',
            },
            {
              group: ['**/sessions-index.ts'],
              importNames: ['saveIndex'],
              message:
                'store 外禁 import sessions-index 落盘函数（索引是可丢缓存）——索引维护归 RecordStore 内部（H4/G1，D7 守卫分级）',
            },
          ],
        },
      ],
    },
  },
  // [HISTORICAL] useContenteditableInput.ts 是 composer 富文本输入的唯一聚合点：
  // 视觉行移动（getClientRects+caretRangeFromPoint）+ segments 解析（getSegmentsFromEl）
  // + 草稿/光标/IME/粘贴事件处理 + Cmd+V 双通路图片粘贴。各职责共享 savedRange/preferredX
  // 闭包与 contenteditable DOM 语义，强行拆分会破坏闭包封装或引入跨模块状态同步。
  // 行数在 wave4（双通路粘贴）后超 500，短期 max-lines override 避免阻塞。
  {
    files: ['packages/renderer/src/composables/panel/useContenteditableInput.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] Turn.vue 是 message-stream 的唯一 turn 聚合组件：user 气泡（含 image segment
  // 缩略图）+ assistant summary + trace 区（merged/single 双分支 + Transition 动画）+ streaming
  // 光标 + fork/复制 等操作行。conversation-density slice（merged 卡片）与 main 的 image-attach
  // + trace Transition 合并后行数超 500（template ≤400 / script setup ≤300 均合规，仅总行数超标）。
  // 拆分需先理清 user/summary/trace/action 四块的职责边界，属独立重构任务。短期 override 避免阻塞。
  //
  // [HISTORICAL·模板结构角度] 同文件还有一处历史 override（原 PR #112 补充）：Turn.vue 也是单回合
  // 展示的唯一组件，模板结构（350+ 行）与 script setup（300 行）职责内聚，拆分子组件需传递 15+
  // props/slots，收益不抵成本。useTurnActions 已提取 handler 层，剩余为模板渲染逻辑。
  // 该条与上方 conversation-density 角度的说明规则相同（max-lines: off），原为两处独立 override 块，
  // 现合并为一处（ESLint 合并规则使其功能无碍，合并仅为消除冗余），保留两段决策注释供追溯。
  {
    files: ['packages/renderer/src/components/panel/message-stream/Turn.vue'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] SystemPage.vue 是 Settings 系统页的唯一聚合组件：语言与外观（locale/theme/fontSize/
  // completionSound/autoRename）+ 系统提示音（success/error 双 Select + 试听）+ 配色主题（muted/colorful
  // swatches）+ 快捷键重录（录制/重置/onRecordKeydown）。各职责共享 SystemSettings props/emit 与
  // commandStore 闭包，强行拆分子组件需传递 10+ props/slots（如快捷键段需 recordingId/DEFAULT_KEYS/
  // shortcutOverrides/startRecording/cancelRecording/onRecordKeydown/resetShortcut 全套），收益不抵成本。
  // 版本检查卡片已拆出 UpdateCheckCard.vue（独立关注点），剩余 538 行均为系统设置内聚职责。
  // 原始已 534 行（github/main 基线即超限），同质于 event-adapter/session-service/Turn.vue 的唯一
  // 聚合中心，短期 max-lines override 避免阻塞。
  {
    files: ['packages/renderer/src/components/settings/SystemPage.vue'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] ConfigService 是 config 域唯一聚合点（settings-message-handler 全部 config.* case 的
  // 注入端），随功能以纯委托行增长——真实逻辑已在 worktree-config-helper（worktree 偏好 + auto-rename
  // flag/rename 模型）/ config-merge-helpers（system prompt/terminal 合并）等 helper。rename-model 功能
  // +8 行触顶（此前已 499/500 计行，任何新增即超限），拆 Skill CRUD 等区块属独立重构任务，
  // 短期 max-lines override 避免阻塞。
  {
    files: ['packages/runtime/src/services/config-service.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] useChatStore 是 Pinia chat store 的唯一 setup 函数（defineStore('chat', () => {...})），
  // 包含所有 chat state（messages Map 分区 / streaming / pending / retry / queue）+ 全部 action
  // （appendUser/appendPending/applyMessageEvent/finalize/hydrate/truncateFrom 等 30+ 方法）。
  // 与 event-adapter/session-service 同性质——唯一聚合中心，职责内聚但函数体行数超 300。
  // max-lines-per-function 规则对 Pinia setup 函数不适用（setup 天然是单一大函数），override 避免误报。
  // max-lines：chat.ts 作为消息流核心 store 承载多种消息类型处理（assistant 流式 + bash 执行 +
  // subagent + compaction/branch + retry/queue + LRU + handoff + changeset），职责内聚但行数超 500
  // （当前 ~900 行，main 分支基线已 872 行）。同质于 event-adapter/session-service 的唯一聚合中心，
  // 短期 max-lines override 避免阻塞，长期应拆分为 chat-core + chat-effects 子模块。
  {
    files: ['packages/renderer/src/stores/chat.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] useProviderEdit 是 Provider 编辑弹窗的唯一 composable 工厂（同 chat.ts 性质），
  // 承载 form/localModels/headerRows 状态 + test/discover/save 编排 + 模型/headers CRUD +
  // compat 编辑器展开态 + isDirty 快照 + 过期刷新 watch。职责内聚但函数体超 300 行。
  // 与 chat.ts setup 同理：唯一聚合中心，max-lines-per-function 规则不适用，override 避免误报。
  // [HISTORICAL] arch-fix-v2 归位：useProviderEdit 迁至 packages/core/src/domain/settings/（M1a 新包），
  // files 模式补新路径（旧 renderer 路径文件已删，仅保留作迁移记录）。
  {
    files: [
      'packages/renderer/src/composables/features/useProviderEdit.ts',
      'packages/core/src/domain/settings/use-provider-edit.ts',
    ],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
  // [HISTORICAL] createChatStore 是 core 域 chat store 的唯一 setup 函数（自 renderer stores/chat.ts 迁入，
  // P3 chat 域绞杀 w4）。与 renderer chat.ts 同性质——唯一聚合中心，setup 天然是单一大函数，
  // max-lines-per-function 规则不适用（项目已裁定该场景为误报，对齐 renderer chat.ts 同款 override）。
  // B6 *Impl 消除（FR2 内联）后函数体 345 行；深模块化已由 streaming-state-machine 承担（FR1），
  // 不再为绕行数拆分模块级函数（B6 反模式）。
  // [u6.1] D6 facet 收口：testInternals 命名空间 + ChatStoreReaders/ChatStoreOps 类型及
  // 编译期完备性/互斥断言就地挂本文件（facet 与 return 面同文件才能锚定 Pick 键集），
  // 文件总行数超 500——对齐 renderer stores/chat.ts 同款「唯一聚合中心」总行数豁免。
  {
    files: ['packages/core/src/domain/chat/store.ts'],
    rules: {
      'max-lines-per-function': 'off',
      // chat store 聚合中心：live/reload 双通路共用 reducer 的等价性设计要求单一 applyEntry
      // 归属地，拆分属独立重构——行数豁免（总行数豁免理由见上 [u6.1] 注释）。
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] buildWorkerScript 是 worker 源码生成器——返回单一字符串数组的纯模板函数，
  // 数组每个元素是生成脚本的逐行源码。AC-4 不变式要求脚本格式逐字保留（用户资产：workflow 脚本
  // 依赖 agent/parallel/pipeline/$ARGS/$BUDGET 等注入契约），不可为凑行数随意合并/拆分行。
  // returnMeta 透传补全后函数体超 300（303），属同质唯一聚合中心，override 避免误报。
  {
    // [u1-move] 文件随 core 切面迁入 packages/subagent-core（subagent-core 包抽离），
    // override 路径同步跟随，约束语义不变。
    files: ['packages/subagent-core/src/orchestration/worker-script-builder.ts'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
  // [HISTORICAL] i18n settings 字典（zh-CN/en-US 镜像）是 settings 全文案的 SSOT，
  // 每新增一个设置项需双语同步追加。auto-rename-session 开关追加后行数微超 500（501 行），
  // 属唯一聚合中心、结构内聚（扁平 key），强行拆分需设计 per-section 文件组织，
  // 收益不抵成本。短期 max-lines override 避免阻塞。
  {
    files: [
      'packages/renderer/src/i18n/locales/zh-CN/settings.ts',
      'packages/renderer/src/i18n/locales/en-US/settings.ts',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] core 包纯净性强制（AC2，renderer-rebuild v2 §11.4 验收基准）：
  // core 零 `node:` / 零 window.electronAPI / 零直接 localStorage/WebSocket（lint 强制）。
  // 平台能力（KVStorage/WebSocketFactory/ipc）经 PlatformPort 注入，禁止绕过。
  // overrides 按 packages/core/src 路径限定，不触碰 renderer/ui/mobile 存量（ES2）。
  // 新增规则时必须先确认 core 现有代码零命中（2026-08-03 审计：零实际使用，仅注释提及）。
  {
    files: ['packages/core/src/**/*.{ts,vue}'],
    rules: {
      'no-restricted-globals': ['error', 'window', 'localStorage'],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'core 包禁止 node: import——平台能力经 PlatformPort 注入' },
            { group: ['ws'], message: 'core 包禁止直连 ws 包——WebSocket 经 PlatformPort.webSocket.create' },
            { group: ['electron'], message: 'core 包禁止 import electron——ipc 经 PlatformPort' },
            // [HISTORICAL] AC10 跨域铁律（W5 drawer-boundaries-gate，FR7 终验收）：
            // domain 内文件禁止 import 任何「@xyz-agent/core/domain/<域>/<内部模块>」包名路径（含同域内部路径——
            // 域内应走相对路径）。合法形态：单层 '@xyz-agent/core/domain/<域>'（index.ts 公开 API，
            // minimatch * 不跨 / 故单层不匹配下方 pattern）或 '@xyz-agent/core'（包入口 index.ts）。
            // 相对路径跨域（深度可变，patterns 无法表达）由 scripts/check-domain-boundaries.sh 兜底。
            // 2026-08-04 审计：domain 下零包名内部路径 import，规则落地零命中。
            { group: ['@xyz-agent/core/domain/*/*'], message: 'AC10 跨域铁律：domain 内禁 import 域内部模块（包名形式）——经 @xyz-agent/core/domain/<域> 公开 index API 或 @xyz-agent/core 包入口消费' },
            { group: ['@xyz-agent/core/domain/*/**/*'], message: 'AC10 跨域铁律：domain 内禁 import 域内部深层模块（包名形式）——经公开 index API 消费' },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="WebSocket"]',
          message: 'core 包禁止 new WebSocket——经 PlatformPort.webSocket.create 创建',
        },
      ],
    },
  },
  // [HISTORICAL] subagent-workflow factory（src/index.ts）是 extension 的唯一装配点：
  // 注册 3 tool + 2 command + messageRenderer + pi.__workflowRun + 4 个 session 事件 handler
  // （session_start 单独就 ~100 行：双 Service 装配 + AgentRegistry + store 健康度 + recovery）。
  // 与 event-adapter/session-service/chat.ts 同质——唯一聚合中心，职责内聚但函数体超 300。
  // 拆分需先把 session_start handler 及 makeDeps/log/resolveSessionDir 等闭包内函数提取到
  // 模块级（需透传 pi/sessionState/registry 等大量闭包变量），属独立重构任务。
  // 短期 max-lines-per-function override 避免阻塞（HEAD 版已 321 行超限，属存量）。
  {
    files: ['extensions/universal/subagent-workflow/src/index.ts'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
  // pi extensions（extensions/**/*.ts）专用规则块。
  // extensions 是无构建的 TS 源码（pi 运行时直接加载），迁自 xyz-pi-extensions 仓库，
  // 与 renderer/runtime 的 Vue/Electron 代码性质不同：
  //   - 缩进：源项目用 tab（pi 生态约定），不强制 2-space。关掉 indent 规则保留既有约定。
  //   - 行数上限：放宽到 1000（源项目约定，extensions 逻辑比 Vue 组件更聚合）。
  //   - 启用迁自 pi-taste-lint 的 4 条 TS 向品味规则（注册在 tastePlugin 但不在默认 tasteRules，
  //     仅在此块开启，不影响 renderer/runtime）。
  {
    files: ['extensions/**/*.ts'],
    rules: {
      'indent': 'off',
      'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
      'taste/no-unsafe-cast': 'warn',
      'taste/no-unbounded-while-true': 'warn',
      'taste/no-inline-import-type': 'warn',
      'taste/no-unsafe-object-entries': 'warn',
    },
  },
  // [HISTORICAL] extensions 源码禁裸 console（2026-08 日志清理 U4/D6，与迁移同批落地）：
  // raw stderr 在 TUI alternate-screen 下越过渲染层污染输入区（logging-conventions SSOT
  // 关键约束 1）。诊断日志统一走 @zhushanwen/pi-extension-logger（warn/error → appendEntry，
  // debug → XYZ_AGENT_DEBUG=1 文件日志）。范围限 src 源码：测试文件的 spyOn/monkey-patch
  // 与 teardown 兜底属测试基建，不在守卫目标内（worker-script-builder 的 console.* 在生成
  // 脚本字符串字面量内，AST 不命中，无需豁免）。
  {
    files: ['extensions/**/src/**/*.ts'],
    ignores: ['extensions/**/src/__tests__/**', 'extensions/**/__tests__/**', 'extensions/**/*.test.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  // [HISTORICAL] subagent-core 源码禁裸 console（恢复迁移前 extensions/**/src 的等价
  // 约束面）：@zhushanwen/subagent-core 由 extensions/universal/subagent-workflow 的
  // core 切面抽离（u1-move），迁移前该源码受上方 extensions no-console:error 块约束，
  // 抽离后 extensions glob 不再命中——本块恢复同强度约束，防裸 console 渗入跨宿主
  // 共享层。范围同样限 src 源码：__tests__/ 与 *.test.ts 属测试基建（spyOn /
  // monkey-patch），不在守卫目标内。
  {
    files: ['packages/subagent-core/src/**/*.ts'],
    ignores: [
      'packages/subagent-core/src/core/**',
      'packages/subagent-core/src/**/__tests__/**',
      'packages/subagent-core/src/**/*.test.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },
  // [subagent-core 抽离 P0（新规则例外，沿用 [HISTORICAL] 登记风格）] core log 端口的
  // 缺省 sink 按 subagent-core 设计 D2 即为 console（docs/design/
  // subagent-core-package-extraction.md §3.3 D2「缺省 console」）：configureCore 之前
  // 宿主 appendEntry 通道不存在，console 是唯一可用出口，该路径仅测试与库误用场景
  // 可达（host-services.ts 的 NULL_HOST.log）。故不走行内注释豁免形态（对应
  // taste 守卫规则语义），统一走本配置级 override。
  // [u1-move] src/core 随 core 切面迁入 packages/subagent-core（subagent-core 包抽离），
  // override 路径同步跟随，约束语义不变。
  {
    files: ['packages/subagent-core/src/core/**'],
    rules: {
      'no-console': 'off',
    },
  },
  // [HISTORICAL] resource-discovery.ts 的 3 处 Promise.all（源级/包级/scoped 子包级）触发
  // taste/prefer-allsettled 属规则误报，per-file override 关闭。规则设计针对「独立数据源
  // 可部分降级」场景；本文件三处是 swf-perf-impl cleanup slice（TC2/IF2，见
  // .cw/swf-perf-impl/cleanup-slice-design.json）把串行扫描并行化的产物，硬约束是
  // 输出与异常传播语义均与串行版等价：每级预期失败已由内部既有 catch 面承担
  // （access/readdir/processPackage），未捕获异常必须向上抛（Promise.all 整体 reject
  // ↔ 串行版向上抛）。allSettled + 部分失败返回 [] 是设计中明确否决的 alternative
  // （会吞掉未捕获异常的向上传播，改变调用方可观察行为）。故禁用 eslint-disable 行内
  // 注释形态（taste/no-eslint-disable 语义），统一走本配置级 override。
  // 路径随 extensions 分组重构补 universal/ 段（2026-08-25：原 glob 缺段致 override 失配、
  // 3 处 warning 漏网）。
  // [u1-move] 文件随 core 切面迁入 packages/subagent-core（subagent-core 包抽离），
  // override 路径同步跟随，约束语义不变。
  {
    files: ['packages/subagent-core/src/shared/resource-discovery.ts'],
    rules: {
      'taste/prefer-allsettled': 'off',
    },
  },
  // [lint 清零 2026-08-30] ui primitives 层豁免 taste/no-native-html-elements：
  // 规则目标是业务/feature 组件直接用原生表单元素（应换 xyz-ui 组件）；primitives/**
  // 正是 xyz-ui 组件的实现层——Input.vue/Textarea.vue 的本职就是包装原生
  // input/textarea（含 focus/blur 转发与样式 token），让其「用 <Input/>」是自引用
  // 悖论。规则域排除实现层，业务组件面（features/**）不受影响仍全量约束。
  {
    files: ['packages/ui/src/primitives/**/*.vue'],
    rules: {
      'taste/no-native-html-elements': 'off',
    },
  },
  // [lint 清零 2026-08-30] subagent-core 迁移过渡 max-lines：下列文件随 u1-move 从
  // extensions 域（上限 1000）迁入 packages 域（上限 500），迁移本身不改内容——
  // 在原域合规（≤1000）的文件不应因路径迁移即触发拆分。抽离已显著瘦身（旧位行数：
  // subagent-service 2141→1245、session-runner 1781→844、record-store 1234→800），
  // 进一步拆分属独立重构任务，长期方向登记于 subagent-core 抽离 impl-plan 残留风险。
  //
  // [u-2a] session-runner.ts 再从 execution/ 根物理迁入 engines/pi/（pi 执行轨道下沉，
  // A1 零回归约束 = rename 级搬运不拆分），override 路径同步跟随（1111891ce rename
  // 先例同型）。长期拆分方向：interact 交接 / stdin 写入等可按轴再拆，待独立重构。
  {
    files: [
      'packages/subagent-core/src/execution/execution-record.ts',
      'packages/subagent-core/src/orchestration/worker-message-pump.ts',
      'packages/subagent-core/src/shared/resource-discovery.ts',
    ],
    rules: {
      'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
    },
  },
  // [H4 record 持久化收敛] record-store.ts 单独提额：H4 设计（docs/architecture/
  // subagent-record-persistence-consolidation.md）把 record 全部写面收编进
  // RecordStore（十意图原语 + 同步写权威），U1 API 立面落地后 800→1207，
  // U4a 读面收尾 / U4c rebuildIndexes 还将增长。写面收口与行数守卫是显式
  // 冲突，提额至 1400 过渡；H4 全落地后按意图原语族拆分（终态原语/轮次
  // 簿记/重建三轴）属独立重构任务，登记于 H4 impl-plan 残留风险。
  // [2026-09-13 design-code-sync 追认] 1400→1450：现折算 1429，已破 1400（零余量
  // 反转成必红）；三轴拆分（终态原语/轮次簿记/重建）待排期，拆分完成即回落。
  // 一次性追认、禁止再抬。
  {
    files: ['packages/subagent-core/src/execution/record-store.ts'],
    rules: {
      'max-lines': ['warn', { max: 1450, skipBlankLines: true, skipComments: true }],
    },
  },
  // zcode-engine.ts：zcode app-server 常驻引擎的唯一聚合中心（连接池 + 会话生命周期 +
  // 降级链 + 错误归类）。拆分方向（连接层 / 会话层 / 归类层）属独立重构任务，短期
  // override 避免阻塞。U2 超时收口 + U3 终态 status 分流后与 session-runner 同型提额。
  // [W11] 随 zcode 引擎外移迁入 @zhushanwen/zcode-subagent-cli（W5），路径同步跟随。
  {
    files: ['packages/zcode-subagent-cli/src/zcode-engine.ts'],
    rules: {
      'max-lines': ['warn', { max: 1300, skipBlankLines: true, skipComments: true }],
    },
  },
  // engine-client.ts：协议客户端聚合中心（spawn/握手/帧路由/崩溃重建/收割 + [W3]
  // chat 轮次 recordId 路由面）。H1 chat-run 统一期间收割链与轮次活性承载并入后
  // 541 行，按仓内惯例（偏差 #2 message-dispatcher 同款）登记 override；结构性拆分
  // （正向请求面 / 反向路由面 / 收割面）登记为后续重构债，随 H3 service 拆分轮处置。
  {
    files: ['packages/subagent-core/src/execution/engine/client/engine-client.ts'],
    rules: {
      'max-lines': ['warn', { max: 545, skipBlankLines: true, skipComments: true }],
    },
  },
  // [H3/R4 已消解] subagent-service.ts 单列 override（max 1700）已移除——R4 抽取
  // RunOrchestration（域 #6/#7/#12/#14/#15，strangler 第五单元）+ WorkflowDispatch
  //（[D-R4-1] workflow 族拆分）后壳折算行低于 packages 域 500 上限，warning 消解
  //（impl-plan §7 ⑤ 预授权动作：移除而非抬阈值；演化史——旧位 2141 行即超限，抽离
  // 1245 → 无界等待修复 1415 → u-h2 1471 → W4 监督器 1548 → W3 协议化 1684 →
  // R0 重排折算 1842 → R1 1785 → R2 1640 → R3 后触发告警 → R4 移除本 override）。
  // run-orchestration.ts 单列：R4 核心编排聚合——[D-R4-1] G1 容量偏差的 lint 面
  //（R4 域段实测 1662 物理行 > 两文件 2×700 上限，主 agent 裁决追认超限）。终态实测
  //（阶段3 复核）：本文件 1506 物理行 / 798 折算（R6 常量归一后），workflow-dispatch.ts
  // 527 物理行合规；阈值 800 实余 2 行（零余量锁定语义不变——增长即告警），禁止再抬。
  // [2026-09-13 design-code-sync 兑现] [G1] 段备选预案落地：Continuation 协作面拆出
  // chat-rounds.ts 后，本文件 1077 物理行 / 549 折算——阈值保持 800（余量健康，
  // 增长即告警语义维持，禁止再抬）；chat-rounds.ts 794 物理行 / 365 折算，低于
  // packages 域 500 上限，无需 override（余量健康，不设零余量锁）。
  {
    files: ['packages/subagent-core/src/execution/service/run-orchestration.ts'],
    rules: {
      'max-lines': ['warn', { max: 800, skipBlankLines: true, skipComments: true }],
    },
  },
  // session-reader tool-handler：聚合工具处理中枢（多工具入口 + 渲染调度），
  // extensions 域上限 1000 下长期超限（基线存量）。短期 override 1200，
  // 拆分方向：按工具域拆 handler 子模块。
  {
    files: ['extensions/universal/session-reader/src/tool-handler.ts'],
    rules: {
      'max-lines': ['warn', { max: 1200, skipBlankLines: true, skipComments: true }],
    },
  },
  // download-asset：下载状态机 + 断点续传 + 双引擎降级链（curl/undici 编排 D4/D5/D10）
  // 的单主题模块（apps 域上限 500 下 736 行）。引擎编排段拆分待独立重构，短期 override。
  // [2026-09-06 U03 复杂度重构] 断点续传/校验链/错误分类阶段化提取后 806 代码行——
  // cyclo 已全降 ≤12，按行数再拆属独立任务，对齐 subagent-service 等大文件豁免水平放宽至 1000。
  {
    files: ['apps/electron/main/update/download-asset.ts'],
    rules: {
      'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
    },
  },
  // provider-config-helper：provider 配置读改/清洗/凭据应用聚合中心。
  // 设计 catalog-provider-field-authority §3.3 D1 的写侧防线载体（applyProviderWritePolicy）
  // 驻本文件，且后续单元（M2b 的 listProviders 迁移、M4 的 resolveCatalogDisplayFields 改造）
  // 仍会继续追加，故上限抬到 900（先例：download-asset.ts 抬到 1000）。
  // 沿用既有「sanitize* 校验组拆分是长期方向，短期 override 与 chat.ts 等聚合中心同模式」表述——
  // 长期仍应拆分（防线载体可拆独立模块）。
  {
    files: ['packages/runtime/src/services/provider-config-helper.ts'],
    rules: {
      'max-lines': ['warn', { max: 900, skipBlankLines: true, skipComments: true }],
    },
  },
  // runtime 组合根 main()：装配顺序带文档化时序耦合（函数内注释逐段说明构造先后
  // 与闭包前向引用），与 Pinia setup「天然单一大函数」同理——拆分会割裂装配叙事。
  // createAdapter 闭包 / sd-u5 多播注册等段落的抽取是长期方向，短期 override。
  {
    files: ['packages/runtime/src/index.ts'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
  // [HISTORICAL] session-dead u2/u3b 转移原语+收敛环落地致超限（962→1380），拆分（原语/转移表/收敛环/UserStoppedGate 分域）登记为后续重构项，勿再增行。
  // 提额而非 off：保留 700 软上限告警，超限即再暴露（与 session-runner/zcode-engine 提额先例同型）。
  {
    files: ['packages/runtime/src/services/session/event-interpreter.ts'],
    rules: {
      'max-lines': ['warn', { max: 700, skipBlankLines: true, skipComments: true }],
    },
  },
  // [HISTORICAL] session-dead u2/u3b 语义改动致超限（512>500），拆分登记为后续重构项，勿再增行。
  // 提额至 520 而非 off：微超即提额，保留软上限告警（与 provider-config-helper 提额先例同型）。
  // [merge dev-0.9.17 2026-09] crash-resilience（设计文档已删，git 可追溯）/ crash-forensics-and-watchdog（respawn
  // 编排 + 收殓 + inflight 镜像挂点）与对方 chat 域协议化（userStoppedGate / restore-abort
  // 收敛环）并存，统计行 634 > 520 → 提额 650（微超即提额哲学不变；本块位于 config 末尾，
  // 覆盖上方 idle-pi-reclamation 的 off 块——两块语义冲突时以本软上限为准）。
  {
    files: ['packages/runtime/src/services/session/session-service.ts'],
    rules: {
      'max-lines': ['warn', { max: 650, skipBlankLines: true, skipComments: true }],
    },
  },
  // [HISTORICAL] [u7a 生产补挂 2026-09-12] EngineClient 是引擎协议客户端唯一聚合点
  // （spawn/帧编解码/反向路由/崩溃重建/pidfile），crash-forensics u7a 数据面桥接
  // （反向通道镜像 → core 镜像投影 + 在途推送，D5）入列时净代码行 535 > 520。职责
  // 内聚（桥接消费本类镜像广播），抽独立模块仍余微超且引入新模块边界——微超即提额
  // 先例（session-service 650 / event-interpreter 700 同型）。提额而非 off：保留 650
  // 软上限告警，超限即再暴露。
  {
    files: ['packages/subagent-core/src/execution/engine/client/engine-client.ts'],
    rules: {
      'max-lines': ['warn', { max: 650, skipBlankLines: true, skipComments: true }],
    },
  },
];
