# usage-window

A Claude Code mod that keeps your plan's usage limits in view, so you stop getting cut off mid-task.

- **Band above the prompt:** `5h 42% ↻4:00pm · wk 18% ↻Mon 9:00am · ctx 61%`, amber at 75% and red at 90%, with a note when the reading is more than 5 minutes old.
- **Alerts:** a toast and a desktop notification when the 5-hour or weekly window crosses 75% and again at 90%, once per window.
- **`/usage-window`:** a one-line snapshot, and a Usage pane with a gauge per window, time to reset, burn rate over the last hour with an estimate of when you'd hit 100%, and 24-hour sparklines.
- **Shared across sessions:** every session on the machine shows the newest reading any of them has seen, and they keep one 7-day history.

The figures are the ones Claude Code itself receives with each response: no API key, no extra network calls. They appear after the first response of a session, and only on a Claude subscription plan (Pro, Max, Team, Enterprise); API-key sessions have no rate-limit windows to show.

## Install

At the prompt of a terminal session:

```
/plugin install usage-window --marketplace Schizocarp/usage-window
```

From a shell:

```
claude plugin install usage-window --marketplace Schizocarp/usage-window
```

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Schizocarp/usage-window`, then **Add plugin**.

Answer `y` to add the marketplace, then choose the user scope so every new session loads it. Sessions already open pick it up after `/reload-plugins` or a restart.

## Notes

- A session only gets a fresh reading when it receives a response; other sessions pick that reading up within a minute. Nothing polls in the background.
- Usage from claude.ai or other machines counts against the same limits but shows up only once a session here gets its next response.

## License

MIT
