# Output

The CLI prints a readable report by default. Pass `--json` for machine-readable
output. The report contains `retrievedAt`, `providers`, and sanitised `notices`.
It includes only allowlisted usage-limit fields; provider configuration,
authentication data, account emails, plans, credential fingerprints, reset
credits, URLs, and raw provider errors are omitted.

`retrievedAt` is when this CLI received the current data. A row's `checkedAt`
is the timestamp reported by T3 for that provider's usage-limit data. Native
providers are included when they do not report limits, with
`unavailable: true` and `reason: "notReported"`. Other reasons are
`unsupported`, `probeFailed`, and `invalidSnapshot`.

Source account rows have a qualified `id` and a `sourceId`. Their `label`
includes the source label so similarly named accounts remain distinguishable.
Source error notices identify the source and its checked time when available,
without including the server's error text.

Each window includes `id`, `kind`, `label`, `usedPercent`, and
`remainingPercent`, plus `resetsAt` and `windowDurationMins` when available.
Percentages are numeric and durations are in minutes.

Example:

```json
{
  "retrievedAt": "2026-10-31T12:00:00.000Z",
  "providers": [
    {
      "id": "claude",
      "driver": "claude",
      "label": "Claude Code",
      "enabled": true,
      "checkedAt": "2026-10-31T11:58:00.000Z",
      "unavailable": false,
      "windows": [
        {
          "id": "session",
          "kind": "session",
          "label": "5-hour session",
          "usedPercent": 72.5,
          "remainingPercent": 27.5,
          "resetsAt": "2026-10-31T15:00:00.000Z",
          "windowDurationMins": 300
        }
      ]
    }
  ],
  "notices": []
}
```
