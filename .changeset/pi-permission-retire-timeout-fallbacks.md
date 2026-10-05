---
"@zhushanwen/pi-permission": minor
---

Waiting for your approval no longer fails closed after 5 minutes — the dialog stays open until you decide. The AI risk classifier's built-in 90-second timeout default is also retired: classification runs unbounded unless you configure `classifier.timeout` explicitly (requires pi 1.0.0).
