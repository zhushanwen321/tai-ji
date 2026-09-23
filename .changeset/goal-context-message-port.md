---
'@zhushanwen/pi-goal': patch
---

Route resume/set prompts through the sendContextMessage port: injected steering prompts now go out as custom messages instead of user messages, so the conversation stream no longer fabricates user bubbles. LLM-visible content is unchanged.
