/**
 * Browser half: follow the host's session-focus instructions.
 *
 * DSH has no host API that switches the browser's active session — session
 * selection is client state (`ctx.sessions.open(id)`) — and the Gateway's
 * forwarded-event source is a single slot the Remote assembly already owns, so a
 * plugin cannot push its own host→client event. The two halves therefore meet at
 * a same-origin route: the host publishes *which* session the review wants
 * displayed, and this half performs the switch with the client API that already
 * exists.
 *
 * The switch is the same call the built-in chat view uses when it branches a
 * conversation (`ctx.sessions.fork(...)` then `ctx.sessions.open(childId)`).
 * Here the host has already forked, so this half only opens the session it is
 * told to — and, when a review ends, opens the origin session again.
 *
 * The client context is cordis's own `Context`; there is no separate
 * client-runtime package to import.
 *
 * @module dsh-review/client
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable browser-plugin name. */
export const name = 'dsh-review-client'

/**
 * Client services required.
 *
 * `sessions` is the client Session Controller that owns which session is
 * displayed. Declaring it here means cordis activates this plugin only once that
 * controller exists, so `apply` never has to handle its absence.
 */
export const inject = ['sessions']

/** Host route serving the focus instruction. */
const STATUS_PATH = '/dsh-review/status'

/** How often to ask the host whether it wants a different session displayed. */
const POLL_INTERVAL_MS = 1500

/** The status document, as this half reads it. */
interface ReviewStatus {
  version: string
  active: Array<{ sessionId: string; originSessionId: string; label: string }>
  focus?: { sessionId: string; token: number; reason: 'review' | 'origin' }
}

/** The slice of the client Session Controller this plugin uses. */
interface ClientSessions {
  open(id: string): void
  list: { getSnapshot(): { ids: readonly string[] } }
}

/**
 * Apply the client half.
 *
 * The body is wrapped so that an API-level breaking change degrades to a console
 * error rather than throwing into the DSH loader and raising the "Failed to load
 * plugins" banner: the review workflow lives entirely on the host, and losing the
 * automatic switch only costs the user one manual click in the session list.
 */
export function apply(ctx: Context): void {
  try {
    const sessions = ctx.get('sessions') as ClientSessions | undefined
    if (sessions === undefined) return

    /** The newest focus token this page has already acted on. */
    let actedToken = 0
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    /** Ask the host for the current instruction and act on a new one. */
    const poll = async (): Promise<void> => {
      if (disposed) return
      try {
        const response = await fetch(STATUS_PATH, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) return

        const status = (await response.json()) as ReviewStatus
        const next = status.focus
        if (next === undefined || next.token <= actedToken) return

        // Only act on a session this client can already address. A session the
        // host has forked but not yet announced would open as a blank view and
        // then be replaced, which the user sees as a flicker.
        const known = sessions.list.getSnapshot().ids
        if (!known.includes(next.sessionId)) return

        actedToken = next.token
        sessions.open(next.sessionId)
      } catch {
        // A transient failure (server restarting, page unloading) is expected and
        // self-correcting: the next poll retries and the token stays unconsumed.
      }
    }

    /** Re-arm after each attempt, so a slow host cannot pile up requests. */
    const schedule = (): void => {
      if (disposed) return
      timer = setTimeout(() => {
        void poll().finally(schedule)
      }, POLL_INTERVAL_MS)
    }

    void poll().finally(schedule)

    ctx.effect(() => () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    }, 'dsh-review-client: focus poller')
  } catch (error: unknown) {
    // The host half is unaffected: /review and /end-review keep working; the
    // browser simply does not follow along automatically.
    console.error('[dsh-review] client half failed to load (review commands unaffected):', error)
  }
}
