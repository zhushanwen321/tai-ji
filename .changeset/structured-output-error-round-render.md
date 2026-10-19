---
"@zhushanwen/pi-structured-output": patch
---

Error rounds no longer masquerade as success: a failed structured-output round (for example a schema-validation rejection) used to render the fixed success summary "Final result reported (schema validated)" in the collapsed tool-result line. The render hook now receives the SDK render context and, when the round is flagged as an error, falls back to the first line of the returned content (the actual failure message). Successful rounds keep the fixed one-line summary; callers without the context argument behave as success rounds.
