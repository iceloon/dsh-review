/**
 * Host routes backing the review client half.
 *
 * The client half needs what the browser cannot compute: which session the host
 * wants displayed, and whether a review is active. Both are host facts, so they
 * are served over a same-origin route — the same mechanism other DSH plugins use
 * for their browser halves, and the only one available here, since the Gateway's
 * forwarded-event source is a single slot the Remote assembly already owns.
 *
 * The route is read-only and exposes no conversation content: a focus instruction
 * is a session id plus a counter, and an active-review record is a label. It is
 * restricted to the loopback interface because it names sessions.
 *
 * @module dsh-review/web
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Same-origin path serving the review client half's state. */
export const DSH_REVIEW_STATUS_PATH = '/dsh-review/status'

/**
 * An instruction telling the browser which session to display.
 *
 * `token` is a monotonic counter rather than a timestamp: the client stores the
 * last token it acted on and ignores repeats, so a poll that races a page reload,
 * or two polls in flight at once, still switch sessions exactly once.
 */
export interface ReviewFocus {
  /** Session the browser should open. */
  sessionId: string
  /** Monotonic instruction id; the client acts on each value once. */
  token: number
  /** Why the switch was requested, so the client can phrase its notice. */
  reason: 'review' | 'origin'
}

/** One active review as the client half sees it. */
export interface ReviewStatusEntry {
  /** Session the review is running in. */
  sessionId: string
  /** Session the review will return to. */
  originSessionId: string
  /** Human label of the target under review. */
  label: string
}

/** The status document served to the browser. */
export interface ReviewStatus {
  /** Plugin version, so a stale bundle is visible in the page. */
  version: string
  /** Reviews active right now. */
  active: ReviewStatusEntry[]
  /** The newest focus instruction, when one is outstanding. */
  focus?: ReviewFocus
}

/**
 * Whether the request is addressed to the loopback interface.
 *
 * The `Host` header is the check that matters: it is what a DNS-rebinding page
 * cannot forge, since its own hostname appears there rather than the loopback
 * address it is trying to reach.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/** Write one JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * Register the status route.
 *
 * `webServer` is optional — a headless profile serves no browser — so the caller
 * reaches this through `ctx.inject(['webServer'], …)` and nothing breaks when the
 * service is absent.
 *
 * @param ctx - context carrying `webServer`.
 * @param readStatus - callback producing the current status document.
 * @returns the disposer that unregisters the route.
 */
export function registerReviewStatusRoute(
  ctx: Context,
  readStatus: () => ReviewStatus,
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: DSH_REVIEW_STATUS_PATH,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      json(res, 200, readStatus())
    },
  })
}
