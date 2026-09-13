/**
 * Review-branch boundary resolution.
 *
 * A DSH session can only be forked at a completed-turn boundary, and the Host
 * enforces that itself (`dsh-api-session-controller` rejects an anchor inside an
 * open turn rather than clipping backward). Resolving the boundary here, before
 * calling `fork`, is what lets the plugin decide to review in place instead of
 * surfacing a raw `session/fork-unavailable` to the user.
 *
 * @module dsh-review/branch
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * Resolve the completed-turn boundary a review branch may be cut from.
 *
 * Mirrors the Host's fork rule exactly: the boundary is the first `turn/end` at
 * or after the anchor, so the child keeps whole turns only. An anchor past the end
 * of the log means "the newest completed turn", which is the only sensible reading
 * when the anchor came from a live view that has since moved on.
 *
 * @param agent - agent whose session would be forked.
 * @param anchorSeq - inclusive seq the review started at, when known.
 * @returns the boundary seq, or `undefined` when no completed turn covers it.
 */
export function resolveBranchBoundary(agent: Agent, anchorSeq: number | undefined): number | undefined {
  const events = agent.session.snapshotEvents()

  if (anchorSeq === undefined) {
    return events.findLast(event => event.type === 'turn/end')?.seq
  }

  const atOrAfter = events.find(event => event.type === 'turn/end' && event.seq >= anchorSeq)
  if (atOrAfter !== undefined) return atOrAfter.seq

  const lastSeq = events.at(-1)?.seq ?? -1
  if (anchorSeq > lastSeq) return events.findLast(event => event.type === 'turn/end')?.seq

  return undefined
}
