---
"@zhushanwen/pi-notify-ledger-host": minor
---

Retire the optional `sendDisplayMessage` port: notification delivery is back to the single `sendDelivery` wake-turn channel, and the `sendDisplayMessage` factory option is removed from `CreatePiNotifyLedgerHostOptions` (requires pi 1.0.0).
