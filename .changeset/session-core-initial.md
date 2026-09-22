---
'@zhushanwen/session-core': minor
---

New package: canonical session model and zero-dependency JSONL primitives shared by session readers and importers. Exports the strict `Entry`/`ParseResult`/`SessionHeader`/`NormalizedSession` model, `parseSessionContent`/`parseSessionFile`, the pi-byte-compatible `serializeSession`, the `readFirstJsonlLine`/`readFirstJsonlLineSync` first-line byte primitive (CRLF/LF aware), the `sessionIdFromFileName` filename invariant, and the `normalizeZcodeRowId` zero-padded hex id normalizer. Header validity predicates are intentionally excluded — each consumer keeps its own thin wrapper.
