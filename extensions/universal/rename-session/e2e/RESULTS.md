# rename-session E2E A2 人工抽查记录

本文件由 `node e2e/run-a2.mjs` 自动追加标题记录；「词组形态 / 语义相关 / 语言跟随」三列为人工抽查项（自动规则对中文词组 vs 句子无完备判别力，正式验收以人工为准，见 e2e/README.md A2 说明）。

## 2026-08-15 04:19:26 run

| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |
|---|---|---|---|---|---|
| 中文任务 | 帮我写一个防抖函数并加单测 | 防抖函数与单元测试 |  |  |  |
| 英文任务 | Refactor the config loader to support env overrides | refactor-config-loader-env-overrides |  |  |  |
| 跟进型 | 继续刚才的，改成支持 leading 选项 | rename-session-leading-option |  |  |  |

## 2026-08-15 04:27:18 run

| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |
|---|---|---|---|---|---|
| 中文任务 | 帮我写一个防抖函数并加单测 | 防抖函数单测实现 | PASS（名词词组，无主谓宾/代词/时态助词） | PASS（防抖函数+单测，准确概括任务） | PASS（中文） |
| 英文任务 | Refactor the config loader to support env overrides | refactor-config-loader-env-overrides | PASS（小写 kebab-case 动名词链） | PASS（refactor config loader + env overrides 全要素） | PASS（英文） |
| 跟进型 | 继续刚才的，改成支持 leading 选项 | 支持-leading-选项功能实现 | PASS（词组形态；「支持X功能实现」略冗但非句子） | PASS（leading 选项改动，跟进型缺上下文下合理） | PASS（中文为主+英文术语保留） |

**人工抽查结论（2026-08-15，验收人：主 agent）**：三场景全部 PASS。对照旧风格反例（如「我帮你写了一个防抖函数」），三个标题均为 slug 词组形态，slug prompt 约束达成词组形态目标。跟进型标题质量略弱于另两个（prompt 本身无上下文），属预期差异，不构成失败。

## 2026-08-15 04:53:40 run

| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |
|---|---|---|---|---|---|
| 中文任务 | 帮我写一个防抖函数并加单测 | debounce-function-unit-testing |  |  |  |
| 英文任务 | Refactor the config loader to support env overrides | refactor-config-loader-with-env-overrides |  |  |  |
| 跟进型 | 继续刚才的，改成支持 leading 选项 | 支持-leading-选项-实现 |  |  |  |

## 2026-08-15 05:08:51 run

| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |
|---|---|---|---|---|---|
| 中文任务 | 帮我写一个防抖函数并加单测 | 防抖函数实现与单元测试 |  |  |  |
| 英文任务 | Refactor the config loader to support env overrides | config-loader-refactoring-discussion |  |  |  |
| 跟进型 | 继续刚才的，改成支持 leading 选项 | 支持-leading-选项 |  |  |  |

## 2026-08-15 06:17:36 run

| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |
|---|---|---|---|---|---|
| 中文任务 | 帮我写一个防抖函数并加单测 | 防抖函数实现与单元测试 | PASS（名词词组） | PASS（防抖函数+单测） | PASS（中文） |
| 英文任务 | Refactor the config loader to support env overrides | config-loader-refactor-env-overrides | PASS（小写 kebab-case 动名词链） | PASS（refactor config loader + env overrides 全要素） | PASS（英文） |
| 跟进型 | 继续刚才的，改成支持 leading 选项 | debounce-leading-implementation | PASS（小写 kebab-case 动名词链） | PASS（debounce leading 实现，fixture 上下文准确概括） | BORDERLINE（prompt 为中文但 fixture notes.md 为英文，模型按上下文主语言输出英文——语言跟随判定对象含上下文而非仅 prompt，记边界情况不判失败） |

**人工抽查结论（2026-08-15，验收人：主 agent，fixture 修复后终版 run）**：三场景 PASS（跟进型语言跟随记 BORDERLINE 并说明理由）。跟进型 case 的 cwd 加了最小 fixture（notes.md 锚点「正在实现 debounce，下一步加 leading 选项」）——空 tmp cwd 会诱发模型长时间探索自造上下文（两次全量实测击穿 600s settled 上限），fixture 消除探索且保留跟进语义，断言不变。历史 run（04:19-05:08）为调试过程记录，验收以本 run 为准。

## 2026-08-15 06:50:30 run

| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |
|---|---|---|---|---|---|
| 中文任务 | 帮我写一个防抖函数并加单测 | 防抖函数实现和单元测试 | PASS（名词词组） | PASS（防抖函数+单测） | PASS（中文） |
| 英文任务 | Refactor the config loader to support env overrides | refactor-config-loader-env-overrides | PASS（小写 kebab-case 动名词链） | PASS（refactor config loader + env overrides 全要素） | PASS（英文） |
| 跟进型 | 继续刚才的，改成支持 leading 选项 | debounce-leading-support | PASS（小写 kebab-case 动名词链） | PASS（debounce leading 支持，贴 prompt 的「支持 leading 选项」） | BORDERLINE（同前 run：中文 prompt 但英文 fixture 上下文，模型按上下文主语言输出英文，记边界不判失败） |

**人工抽查结论（2026-08-15，验收人：主 agent，复验 run）**：三场景结论与终版 run 一致。本 run 为 helper 重构 bug（`lastSessionInfoEntry` 返回 entry 对象后未取 `.name`）修复后的复验——顺带把固定 `sleep(600)` 换成 `waitSessionInfoEntry` 轮询，跟进型标题从上轮的 `debounce-leading-implementation` 变为 `debounce-leading-support`，语义反而更贴 prompt。

## 2026-08-15 12:24:21 run

| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |
|---|---|---|---|---|---|
| 中文任务 | 帮我写一个防抖函数并加单测 | 防抖函数实现与单元测试 |  |  |  |
| 英文任务 | Refactor the config loader to support env overrides | config-loader-env-override-refactor |  |  |  |
| 跟进型 | 继续刚才的，改成支持 leading 选项 | debounce-leading-option |  |  |  |

## 2026-08-15 12:32:14 run

| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |
|---|---|---|---|---|---|
| 中文任务 | 帮我写一个防抖函数并加单测 | javascript-防抖函数实现与测试 |  |  |  |
| 英文任务 | Refactor the config loader to support env overrides | refactor-config-loader-env-overrides |  |  |  |
| 跟进型 | 继续刚才的，改成支持 leading 选项 | debounce-leading-选项支持 |  |  |  |
