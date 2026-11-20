import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, SessionRateLimit } from 'claude-code'

import type { Reading, Sample, Window } from '../types'

const PANE = 'usage-window'
const TITLE = 'Usage'
const WARN = 75
const DANGER = 90
const STALE_MS = 5 * 60_000
const KEEP_MS = 7 * 24 * 3_600_000
const SAMPLE_GAP_MS = 2 * 60_000

const reading = atom({ plugin: 'usage-window', key: 'reading' } as const, null, {
  shape: 'reading-1',
})
const history = atom({ plugin: 'usage-window', key: 'history' } as const, [], {
  shape: 'history-1',
})
const nowAtom = atom({ plugin: 'usage-window', key: 'now' } as const, 0)

// ---------- pure helpers (exported for tests) ----------

export function pickWindow(limits: readonly SessionRateLimit[], kind: string): Window | undefined {
  const w = limits.find(l => l.kind === kind)
  return w ? { pct: w.percentUsed, resetsAt: w.resetsAt } : undefined
}

export function level(pct: number | undefined): 'success' | 'warning' | 'error' | undefined {
  if (pct === undefined) return undefined
  if (pct >= DANGER) return 'error'
  if (pct >= WARN) return 'warning'
  return 'success'
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/** "3:10pm" today, "Mon 3:10pm" otherwise. */
export function fmtReset(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const h = d.getHours()
  const time = `${h % 12 === 0 ? 12 : h % 12}:${pad(d.getMinutes())}${h < 12 ? 'am' : 'pm'}`
  const today = new Date(now)
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return time
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `${days[d.getDay()]} ${time}`
}

export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 48) return m ? `${h}h ${m}m` : `${h}h`
  return `${Math.round(h / 24)}d`
}

/**
 * Burn rate of the 5-hour window over the last hour, in % per hour, and the
 * time until it reaches 100%. Needs two samples of the same window at least
 * 10 minutes apart that show a rise.
 */
export function burn(
  samples: readonly Sample[],
  current: Window | undefined,
  now: number,
): { perHour: number; etaMs?: number; beforeReset?: boolean } | undefined {
  if (!current) return undefined
  const since = now - 60 * 60_000
  const same = samples.filter(
    s => s.t >= since && s.five !== undefined && s.fiveReset === current.resetsAt,
  )
  if (same.length < 2) return undefined
  const first = same[0]!
  const last = same[same.length - 1]!
  const spanMs = last.t - first.t
  if (spanMs < 10 * 60_000) return undefined
  const rise = (last.five ?? 0) - (first.five ?? 0)
  const perHour = (rise / spanMs) * 3_600_000
  if (perHour <= 0) return { perHour: 0 }
  const etaMs = ((100 - current.pct) / perHour) * 3_600_000
  const resetAt = current.resetsAt ? new Date(current.resetsAt).getTime() : undefined
  const beforeReset = resetAt === undefined ? true : now + etaMs < resetAt
  return { perHour, etaMs, beforeReset }
}

const SPARK = '▁▂▃▄▅▆▇█'

/** A one-line sparkline of `key` over the last `hours`, `cols` cells wide. */
export function spark(
  samples: readonly Sample[],
  key: 'five' | 'week',
  now: number,
  hours: number,
  cols: number,
): string {
  const start = now - hours * 3_600_000
  const step = (hours * 3_600_000) / cols
  const cells: string[] = []
  let lastVal: number | undefined
  let i = 0
  const pts = samples.filter(s => s.t >= start && s[key] !== undefined)
  for (let c = 0; c < cols; c++) {
    const end = start + (c + 1) * step
    let val: number | undefined
    while (i < pts.length && pts[i]!.t < end) {
      val = Math.max(val ?? 0, pts[i]![key] as number)
      i++
    }
    if (val === undefined) {
      cells.push(lastVal === undefined ? ' ' : SPARK.charAt(Math.min(7, Math.floor(lastVal / 12.5))))
    } else {
      lastVal = val
      cells.push(SPARK.charAt(Math.min(7, Math.floor(val / 12.5))))
    }
  }
  return cells.join('')
}

// ---------- the mod ----------

/** The newest limit reading any session has seen, kept in the shared store. */
type Latest = { at: number; five?: Window; week?: Window }

function storedHistory(v: unknown): Sample[] {
  return Array.isArray(v) ? (v as Sample[]) : []
}

/**
 * Records a reading. `fresh` is true when it carries limits from a response
 * this session just got: only then is it shared with other sessions and added
 * to the history.
 */
async function record($: Engine, r: Reading, fresh: boolean): Promise<void> {
  await update($, reading, () => r)
  if (!fresh || (!r.five && !r.week)) return
  const latest = (await $.store.get('latest')) as Latest | undefined
  if (!latest || r.at >= latest.at) {
    await $.store.set('latest', { at: r.at, five: r.five, week: r.week } satisfies Latest)
  }
  const sample: Sample = { t: r.at, five: r.five?.pct, fiveReset: r.five?.resetsAt, week: r.week?.pct }
  // Merge with what other sessions stored so no session's samples are lost.
  const merged = storedHistory(await $.store.get('history'))
  const last = merged[merged.length - 1]
  const moved = !last || last.five !== sample.five || last.week !== sample.week
  const due = !last || sample.t - last.t >= SAMPLE_GAP_MS
  if (moved || due) {
    merged.push(sample)
    merged.sort((a, b) => a.t - b.t)
  }
  const kept = merged.filter(s => s.t >= r.at - KEEP_MS).slice(-3000)
  await $.store.set('history', kept)
  await update($, history, () => kept)
  await alerts($, r)
}

/** Pulls a newer reading and the history another session stored. */
async function syncShared($: Engine): Promise<void> {
  const latest = (await $.store.get('latest')) as Latest | undefined
  const r = await read($, reading)
  if (latest && (latest.five || latest.week) && (!r || latest.at > r.at || (!r.five && !r.week))) {
    await update($, reading, prev => ({
      at: latest.at,
      five: latest.five,
      week: latest.week,
      ctx: prev?.ctx,
      usd: prev?.usd,
    }))
  }
  const h = storedHistory(await $.store.get('history'))
  const mine = await read($, history)
  if (h.length !== mine.length || h[h.length - 1]?.t !== mine[mine.length - 1]?.t) {
    await update($, history, () => h)
  }
}

  async function alerts($: Engine, r: Reading): Promise<void> {
    const fired = ((await $.store.get('alerted')) as string[] | undefined) ?? []
    const add: string[] = []
    for (const [name, w] of [
      ['5-hour', r.five],
      ['Weekly', r.week],
    ] as const) {
      if (!w) continue
      for (const t of [DANGER, WARN]) {
        if (w.pct < t) continue
        const id = `${name}|${w.resetsAt ?? ''}|${t}`
        if (!fired.includes(id) && !add.includes(id)) {
          add.push(id)
          const when = w.resetsAt ? ` (resets ${fmtReset(w.resetsAt, r.at)})` : ''
          const text = `${name} limit at ${w.pct}%${when}`
          $.ui.toast(text)
          void $.ui.notify(text, { title: 'Claude usage' })
        }
        break // only the highest threshold crossed
      }
    }
    if (add.length) await $.store.set('alerted', [...fired, ...add].slice(-50))
  }

  function fromUsage(
    at: number,
    u: { rateLimits: readonly SessionRateLimit[]; context?: { percent?: number }; cost?: { usd: number } },
  ): Reading {
    return {
      at,
      five: pickWindow(u.rateLimits, 'five_hour'),
      week: pickWindow(u.rateLimits, 'seven_day'),
      ctx: u.context?.percent,
      usd: u.cost?.usd,
    }
  }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'usage-window',
      description: 'Show 5-hour and weekly usage limits (opens the Usage pane)',
    })
    const now = await $.clock.now()
    await update($, nowAtom, () => now)
    $.clock.every(60_000, async () => {
      const t = await $.clock.now()
      await update($, nowAtom, () => t)
      await syncShared($)
    })
    const u = await $.session.usage()
    const r = fromUsage(now, u)
    if (r.five || r.week) await record($, r, true)
    else {
      const prev = await read($, reading)
      await update($, reading, () => ({ ...(prev ?? { at: 0 }), ctx: r.ctx, usd: r.usd }))
    }
    await syncShared($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const now = await $.clock.now()
    const prev = await read($, reading)
    const r = fromUsage(now, e)
    const fresh = e.rateLimits.length > 0
    if (!fresh) {
      // Context or cost moved alone: keep the last known limits and their time.
      r.five = prev?.five
      r.week = prev?.week
      r.at = prev?.at ?? 0
    }
    await record($, r, fresh)
    return result
  })

  on('command.run', { command: 'usage-window' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    const r = await read($, reading)
    const now = await $.clock.now()
    if (!r || (!r.five && !r.week)) {
      return { text: 'No usage reading yet: limits arrive with the first response on a subscription plan.' }
    }
    const parts: string[] = []
    if (r.five) parts.push(`5-hour ${r.five.pct}% (resets ${fmtReset(r.five.resetsAt, now)})`)
    if (r.week) parts.push(`weekly ${r.week.pct}% (resets ${fmtReset(r.week.resetsAt, now)})`)
    if (r.ctx !== undefined) parts.push(`context ${r.ctx}%`)
    return { text: `Usage: ${parts.join(', ')}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, reading)
    const now = (await read($, nowAtom)) || Date.now()
    if (e.props.hasSurvey || !r || (!r.five && !r.week && r.ctx === undefined)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const stale = Boolean(r.five || r.week) && now - r.at > STALE_MS
    return (
      <Box>
        <Text>
          {r.five && (
            <Text color={level(r.five.pct)}>
              5h {r.five.pct}%
            </Text>
          )}
          {r.five?.resetsAt && <Text dimColor> ↻{fmtReset(r.five.resetsAt, now)}</Text>}
          {r.five && r.week && <Text dimColor> · </Text>}
          {r.week && <Text color={level(r.week.pct)}>wk {r.week.pct}%</Text>}
          {r.week?.resetsAt && <Text dimColor> ↻{fmtReset(r.week.resetsAt, now)}</Text>}
          {r.ctx !== undefined && <Text dimColor> · ctx {r.ctx}%</Text>}
          {stale && <Text dimColor> · {fmtDuration(now - r.at)} old</Text>}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Progress } = $.ui.resolve(e)
    const r = await read($, reading)
    const list = await read($, history)
    const now = (await read($, nowAtom)) || Date.now()
    const cols = Math.max(12, Math.min(60, (e.props.bodyColumns ?? 40) - 8))

    if (!r || (!r.five && !r.week)) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No limit reading yet.</Text>
          <Text dimColor>Limits arrive with the first response on a subscription plan.</Text>
        </Box>
      )
    }

    const b = burn(list, r.five, now)
    const stale = now - r.at > STALE_MS

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          {r.five && <Text color={level(r.five.pct)}>5h {r.five.pct}%</Text>}
          {r.week && <Text color={level(r.week.pct)}>wk {r.week.pct}%</Text>}
        </Box>
      )
    }

    const gauge = (name: string, w: Window | undefined) =>
      w && (
        <Box flexDirection="column" marginBottom={1}>
          <Progress
            label={`${name} · resets ${fmtReset(w.resetsAt, now)}${
              w.resetsAt ? ` (in ${fmtDuration(new Date(w.resetsAt).getTime() - now)})` : ''
            }`}
            value={Math.min(100, w.pct)}
            max={100}
            valueText={`${w.pct}% used · ${Math.max(0, Math.round((100 - w.pct) * 10) / 10)}% left`}
            color={level(w.pct)}
          />
        </Box>
      )

    return (
      <Box flexDirection="column">
        {gauge('5-hour window', r.five)}
        {gauge('Weekly window', r.week)}
        <Text weight="semibold">Pace</Text>
        {b === undefined && <Text dimColor>Not enough recent data for a burn rate yet.</Text>}
        {b !== undefined && b.perHour === 0 && <Text dimColor>No rise in the last hour.</Text>}
        {b !== undefined && b.perHour > 0 && (
          <Text color={b.beforeReset ? level(r.five && r.five.pct >= WARN ? r.five.pct : WARN) : undefined}>
            {Math.round(b.perHour * 10) / 10}%/h ·{' '}
            {b.beforeReset
              ? `hits 100% in ~${fmtDuration(b.etaMs ?? 0)}`
              : 'resets before you hit the limit'}
          </Text>
        )}
        <Box marginTop={1} flexDirection="column">
          <Text weight="semibold">Last 24h</Text>
          <Text dimColor>5h </Text>
          <Text mono>{spark(list, 'five', now, 24, cols)}</Text>
          <Text dimColor>wk </Text>
          <Text mono>{spark(list, 'week', now, 24, cols)}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {r.ctx !== undefined && <Text dimColor>Context {r.ctx}% full</Text>}
          {r.usd !== undefined && <Text dimColor>Session cost ${r.usd.toFixed(2)}</Text>}
          <Text dimColor>
            Reading {fmtDuration(now - r.at)} old{stale ? ' (stale)' : ''}
          </Text>
        </Box>
      </Box>
    )
  })
}
