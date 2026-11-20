export type Window = { pct: number; resetsAt?: string }

export type Reading = {
  /** When the reading was taken, epoch ms. */
  at: number
  five?: Window
  week?: Window
  /** Context window fill, 0-100. */
  ctx?: number
  /** Session cost in USD. */
  usd?: number
}

/** One point of history: epoch ms and the two window percentages. */
export type Sample = { t: number; five?: number; fiveReset?: string; week?: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-window': {
      reading: Shaped<Reading | null>
      history: Shaped<Sample[]>
      now: number
    }
  }
}
