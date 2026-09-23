---
'@zhushanwen/pi-rename-session': patch
---

Title generation now gives the LLM a 2048-token output budget so reasoning models can finish their thinking phase and still produce a title; previously the tight budget could yield empty or truncated session titles on reasoning models.
