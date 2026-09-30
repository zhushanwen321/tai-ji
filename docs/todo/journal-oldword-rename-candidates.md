# TODO：record 域残余 journal 旧词改名（journal → events 词族收尾）

## 背景

事件流升格裁决（`docs/CONTEXT.md`「落盘键的旧词裁决」）把 journal 旧词改成现行词：落盘键（`engineHandle.journalPath` → `eventsPath`、注册条目锚点键 → `recordPath`）与五个遗留符号/文件名（`JsonlEventStream` / `RecordEventsWriteFace` / `RecordEventFoldState` / `event-tail.ts` / `events-projection.ts`）已在 commit `b48d1a373` / `bd4b5b701` 完成。本文件登记实测中发现的**残余旧词**（不在原遗留清单，未改）。

## 现状（待改名清单）

- record 域（`packages/subagent-core/src/execution/persistence/record-events.ts`）：`RecordJournalEvent` / `RecordJournalEventInput` / `RecordJournalHeader` 及文件内 journal 措辞（如 `createRecordEventJournal` / `RecordEventJournal` 接口名）。
- runtime（`packages/runtime/src/services/session/events-projection.ts`）：`JournalProjectionSources` / `initialJournalProjectionSources` / `mergeJournalProjection`。

## 保留边界（现行词，不改）

引擎域自己的 journal 概念（`engine/common/event-journal.ts` 的 `JournalWriter`、zcode 引擎 `journal-io.ts`、磁盘文件名 `journal-<taskId>.jsonl`）与 run 域 journal 概念（`run-event-journal.ts` 等）——与已改名批次同一条边界线。

## 实现要点

- 纯符号改名（无落盘键变化），但跨包引用面广（core / runtime / barrel 导出 / 测试 / 文档符号漂移检查），参照 `bd4b5b701` 的改名批次手法：git mv（如涉及文件）→ 只 add 本批路径 → 断言暂存清单 → 提交。
- 同批更新 `docs/CONTEXT.md` 的「遗留符号改名」段与本文件（完成后本文件删除，git 可追溯）。
