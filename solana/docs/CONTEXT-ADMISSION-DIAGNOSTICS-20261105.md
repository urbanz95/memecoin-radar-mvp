# Context admission diagnostics (2026-11-05)

The focused health sampler now emits `contextAdmission` alongside the existing raw `counterDeltas`. It reports aggregate context skips, durable-backlog skips, ingress-buffer skips, non-negative unattributed skips, and a `causeAccountingComplete` flag.

The flag is **false** when either cause counter is absent at the start or end of the observation or when their summed deltas do not exactly match the aggregate delta. This avoids silently treating an older uninstrumented scanner as fully attributed. Negative attribution discrepancies are not silently represented as negative skipped notifications; compare the three raw counters when the flag is false.

This is an **observability-only change**. It does not change HTTP budget, priority, admission decisions or queue scheduling, and it does not establish complete token/trade coverage. Use the diagnostic on the next **short** Mainnet run before choosing an admission or enrichment optimization. No live measurement was performed for this change.
