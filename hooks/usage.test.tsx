import { expect, test } from 'claude-code/testing'

import { burn, fmtDuration, level, spark } from './register'

const NOW = Date.UTC(2026, 10, 19, 18, 0, 0)
const RESET = new Date(NOW + 3 * 3_600_000).toISOString()

test('helpers: levels, durations, burn rate, sparkline', async () => {
  expect(level(10)).toBe('success')
  expect(level(80)).toBe('warning')
  expect(level(95)).toBe('error')
  expect(fmtDuration(90 * 60_000)).toBe('1h 30m')

  const samples = [
    { t: NOW - 40 * 60_000, five: 40, fiveReset: RESET },
    { t: NOW, five: 60, fiveReset: RESET },
  ]
  const b = burn(samples, { pct: 60, resetsAt: RESET }, NOW)
  expect(Math.round(b?.perHour ?? 0)).toBe(30)
  expect(b?.beforeReset).toBe(true) // 40% left at 30%/h = 80m, before the 3h reset
  expect(spark(samples, 'five', NOW, 1, 6).length).toBe(6)
})

const BAND = {
  plugin: 'usage-window',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, bodyColumns: 80 },
} as const

test('a measurement draws the band and alerts at 75%', async ($, on) => {
  const toasts: string[] = []
  on('clock.now', () => ({ value: NOW }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' as const } }))
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined }
  })

  await $.session.measure({
    context: { window: 200000, tokens: 122000, percent: 61 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 78, resetsAt: RESET },
      { kind: 'seven_day', percentUsed: 18, resetsAt: RESET },
    ],
    changed: ['context', 'rateLimits'],
  } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  const text = (await ui.find({ type: 'Text', text: /5h 78%/ }))?.text ?? ''
  expect(text.includes('wk 18%')).toBe(true)
  expect(text.includes('ctx 61%')).toBe(true)
  await ui.unmount()
  expect(toasts.length).toBe(1)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const pane = await $.ui.mount({
      plugin: 'usage-window', component: 'Pane', requestId: 'usage-window', surface,
      props: { title: 'Usage', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    } as never)
    expect((await pane.find({ type: 'Text', text: /Context 61% full/ }))?.text).toBe('Context 61% full')
    await pane.unmount()
  }
})
test('a session picks up the newer reading another session stored', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'usage-window' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: (e as { cwd: string }).cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000, percent: 5 }, rateLimits: [] } }))
  const store = new Map<string, unknown>([
    ['latest', { at: NOW - 30_000, five: { pct: 55, resetsAt: RESET }, week: { pct: 33, resetsAt: RESET } }],
    ['history', [{ t: NOW - 30_000, five: 55, fiveReset: RESET, week: 33 }]],
  ])
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  const text = (await ui.find({ type: 'Text', text: /5h 55%/ }))?.text ?? ''
  expect(text.includes('wk 33%')).toBe(true)
  expect(text.includes('ctx 5%')).toBe(true)
  await ui.unmount()
})
