/**
 * Code review for DeepSeek Harness.
 *
 * A port of `@earendil-works/pi-review`'s `/review` and `/end-review` workflow.
 * The review *content* — the rubric, the five target modes, the prompt wording,
 * the summary and fix-follow-up prompts — is byte-identical to the Pi extension,
 * because the review standard is the thing worth preserving. What changed is the
 * surrounding machinery, which had to be rebuilt on DSH's seams:
 *
 * | pi-review | here |
 * |---|---|
 * | `pi.exec(argv)` | `ctx.shell.run()` through the session's sandbox |
 * | `pi.registerCommand` | `ctx.commands.register` |
 * | `ctx.ui.select/editor` | `ctx.userQuestions.ask` (native Web dialogs) |
 * | `pi.sendUserMessage` | `agent.followup()` |
 * | `pi.appendEntry` | in-memory state + the session's own `command/run` log |
 * | `ctx.navigateTree` | a forked review session, returned from via the client half |
 *
 * The one genuine capability gap is conversation branching. Pi could move the live
 * conversation back to an earlier node; DSH's log is append-only and its session
 * selection is *client* state, so a plugin cannot move the browser by itself. The
 * port keeps Pi's shape — review in a branch, return when done — by forking a
 * review session host-side and having the client half follow the host's focus
 * instruction (see `client/`).
 *
 * @module dsh-review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-shell'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { UserQuestionError, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { resolveBranchBoundary } from './branch.ts'
import {
  checkoutPr,
  getCurrentBranch,
  getDefaultBranch,
  hasUncommittedChanges,
  isGitRepository,
} from './git.ts'
import { loadProjectReviewGuidelines, parseReviewArgs } from './guidelines.ts'
import { REVIEW_FIX_FINDINGS_PROMPT, REVIEW_SUMMARY_PROMPT } from './prompts.ts'
import {
  PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE,
  prCheckoutBlocked,
  resolveDirectTarget,
  resolvePullRequestInfo,
} from './resolve.ts'
import { composeReviewMessage, describeTarget, type ReviewTarget } from './targets.ts'
import { DSH_REVIEW_VERSION } from './version.ts'
import { registerReviewStatusRoute, type ReviewFocus, type ReviewStatus } from './web.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-review'

/**
 * Services the review workflow needs.
 *
 * `commands` and `shell` are hard dependencies: without the registry there is no
 * `/review`, and without a shell executor no target can be resolved. Everything
 * else — settings, the user-question channel, the session controller, the web
 * server — is reached through `ctx.get` or `ctx.inject`, because a headless
 * profile legitimately composes none of them and the plugin should degrade
 * rather than fail to load.
 */
export const inject = ['commands', 'shell']

/** Settings namespace owning the plugin's user-editable configuration. */
export const DSH_REVIEW_SETTINGS_NS = 'dsh-review' as SettingsNamespace

/** Plugin configuration. */
export interface Config {
  /**
   * Shared review instructions appended to every review, in every mode.
   *
   * Equivalent to pi-review's "custom review instructions", which it persisted as
   * a session entry; here it is a setting, so it survives across sessions and is
   * editable in the normal Settings UI.
   */
  customInstructions?: string
  /**
   * Whether `/review` runs in a forked review session rather than in place.
   *
   * On by default, matching pi-review's "fresh session" mode: the review gets a
   * clean branch and `/end-review` can hand findings back to the original
   * conversation. Off makes `/review` queue the review prompt into the current
   * session instead — useful when a user wants one continuous transcript.
   */
  branchReview?: boolean
}

export const Config: z<Config> = z.object({
  customInstructions: z.string()
    .description('Shared review instructions appended to every review (all modes)'),
  branchReview: z.boolean().default(true)
    .description('Run each review in a forked session so /end-review can return to the original conversation'),
})

/** One active review. */
interface ActiveReview {
  /** Session the review is running in — the forked one, or the current one when branching is off. */
  reviewSessionId: SessionId
  /** Session to return to when the review ends. */
  originSessionId: SessionId
  /** The target under review, for labels and the summary. */
  target: ReviewTarget
  /** Human label captured at start, so later messages can name the review. */
  label: string
}

/**
 * Active reviews, keyed by the session running them.
 *
 * Keyed rather than held in one module-level slot (which is what pi-review did).
 * Pi ran one conversation per process, so a single slot was correct there; a DSH
 * host serves many concurrent sessions, and one slot would let a session's
 * `/end-review` clear another session's review.
 */
const activeReviews = new Map<SessionId, ActiveReview>()

/**
 * The session the browser should be displaying, and the token identifying that
 * instruction.
 *
 * The host cannot switch the browser's session — session selection is client
 * state — so it publishes the intent here and the client half acts on it. The
 * token makes the handoff idempotent: a client that polls twice, or reloads
 * mid-review, acts on each instruction exactly once.
 */
let focus: ReviewFocus | undefined
let focusSeq = 0

/** Publish a new focus instruction. */
function setFocus(sessionId: SessionId, reason: ReviewFocus['reason']): void {
  focusSeq += 1
  focus = { sessionId: String(sessionId), token: focusSeq, reason }
}

/** Dialog ids, named so answers are matched by label rather than position. */
const MODE_QUESTION_ID = 'review-mode'
const END_QUESTION_ID = 'end-review-action'
const BRANCH_QUESTION_ID = 'review-branch'
const COMMIT_QUESTION_ID = 'review-commit'
const PR_QUESTION_ID = 'review-pr'
const FOLDER_QUESTION_ID = 'review-folder'

/** Option labels. */
const MODE_LABELS = {
  uncommitted: 'Review uncommitted changes',
  baseBranch: 'Review against a base branch',
  commit: 'Review a commit',
  pullRequest: 'Review a pull request (GitHub)',
  folder: 'Review folders or files (snapshot)',
} as const

const END_LABELS = {
  returnOnly: 'Return only',
  returnAndSummarize: 'Return and summarize',
  returnAndFix: 'Return and fix findings',
} as const

/**
 * Outcome of asking the user something.
 *
 * The three cases are deliberately distinct. "Dismissed" is an ordinary
 * cancellation the user caused; "unavailable" means no dialog channel is
 * composed at all (a headless or minimal profile), which is *not* something
 * retrying will fix — and reporting it as a cancellation would leave the user
 * retyping a command that can never prompt.
 */
type AskOutcome =
  | { kind: 'answered'; value: string }
  | { kind: 'dismissed' }
  | { kind: 'unavailable' }

/**
 * Ask one single-choice question.
 *
 * A dismissed dialog is an ordinary cancellation; a missing channel is reported
 * as such. Any other failure also reads as a dismissal, because a review that
 * cannot ask is a review the user did not confirm.
 */
async function askChoice(
  ctx: Context,
  agent: Agent,
  question: AskUserQuestionItem,
  signal: AbortSignal,
): Promise<AskOutcome> {
  const service = ctx.get('userQuestions')
  if (service === undefined) return { kind: 'unavailable' }

  try {
    const answer = await service.ask({ questions: [question], agent, signal })
    const item = answer.answers.find(entry => entry.id === question.id)
    if (item === undefined) return { kind: 'dismissed' }
    if (item.selected.length > 0) return { kind: 'answered', value: item.selected[0] as string }
    const custom = item.custom?.trim()
    return custom === undefined || custom === ''
      ? { kind: 'dismissed' }
      : { kind: 'answered', value: custom }
  } catch (error: unknown) {
    if (error instanceof UserQuestionError) return { kind: 'dismissed' }
    throw error
  }
}

/**
 * Ask for free text.
 *
 * The user-questions protocol has no dedicated text prompt, so this is a
 * single-question request with no options: the UI renders an input, and the
 * answer arrives as `custom`.
 */
async function askText(
  ctx: Context,
  agent: Agent,
  question: AskUserQuestionItem,
  signal: AbortSignal,
): Promise<AskOutcome> {
  return askChoice(ctx, agent, question, signal)
}

/** Message shown when a command needs a dialog that this profile does not compose. */
const NO_DIALOG_MESSAGE =
  'This profile has no interactive question channel, so the review picker cannot be shown. Name the target directly instead, for example: /review uncommitted, /review branch main, /review commit HEAD~1, /review pr 123, or /review folder src.'

/** The working directory recorded by one agent's session, when it recorded one. */
function sessionCwd(agent: Agent): string | undefined {
  return agent.session.header.cwd
}

/**
 * Determine which mode the picker should preselect.
 *
 * pi-review's heuristic, kept exactly: uncommitted changes are the most likely
 * intent, a feature branch suggests a base-branch comparison, and otherwise a
 * specific commit is the remaining meaningful choice.
 */
async function getSmartDefault(
  ctx: Context,
  cwd: string | undefined,
): Promise<keyof typeof MODE_LABELS> {
  if (await hasUncommittedChanges(ctx, cwd)) return 'uncommitted'

  const current = await getCurrentBranch(ctx, cwd)
  const fallback = await getDefaultBranch(ctx, cwd)
  if (current !== null && current !== fallback) return 'baseBranch'

  return 'commit'
}

/**
 * Create the review session for one review, or fall back to the current one.
 *
 * Forking is delegated to the Session Controller because that is the only
 * component that composes a child correctly — it resolves the preset, attaches
 * the workspace, and seeds the completed-turn prefix. When the controller is
 * absent (a headless or minimal profile) the review runs in place rather than
 * failing, which is the same behavior as `branchReview: false`.
 *
 * @returns the session the review runs in, and whether it was forked.
 */
async function createReviewSession(
  ctx: Context,
  agent: Agent,
  anchorSeq: number | undefined,
): Promise<{ sessionId: SessionId; forked: boolean }> {
  const controller = ctx.get('sessionController')
  if (controller === undefined) return { sessionId: agent.session.id, forked: false }

  const boundary = resolveBranchBoundary(agent, anchorSeq)
  if (boundary === undefined) return { sessionId: agent.session.id, forked: false }

  try {
    const result = await controller.fork({ sessionId: agent.session.id, atSeq: boundary })
    return { sessionId: result.sessionId, forked: true }
  } catch (error: unknown) {
    // A fork can legitimately fail (no completed turn, storage fault). Reviewing
    // in place is always better than refusing to review, so this degrades and
    // the caller reports which mode it used.
    ctx.logger?.warn('dsh-review: could not fork a review session; reviewing in place', error)
    return { sessionId: agent.session.id, forked: false }
  }
}

/**
 * Deliver one prompt to whichever agent owns the review session.
 *
 * The invoking agent is passed in rather than looked up: when the review runs in
 * place, that agent *is* the review agent, and resolving it again through
 * `ctx.agents` would both depend on a service the plugin does not require and
 * reject the exact live instance the command handler was already handed. The
 * registry is consulted only for a forked session, which is a different agent by
 * construction.
 */
function deliverReviewPrompt(
  ctx: Context,
  invokingAgent: Agent,
  reviewSessionId: SessionId,
  message: string,
): boolean {
  const target = reviewSessionId === invokingAgent.session.id
    ? invokingAgent
    : ctx.get('agents')?.get(reviewSessionId)

  if (target === undefined) return false

  target.followup(createUserMessage({
    content: [{ type: 'text', text: message }],
    source: { kind: 'plugin', plugin: name },
  }))
  return true
}

/** Register `/review`. */
function registerReviewCommand(ctx: Context, config: () => Config): void {
  ctx.commands.register({
    name: 'review',
    description: 'Review code changes (PR, uncommitted, branch, commit, or folders)',
    input: {
      hint: '[uncommitted|branch <name>|commit <sha>|pr <number|url>|folder <paths>] [--extra "text"]',
    },
    handler: async (invocation) => {
      const { agent, rawInput, signal } = invocation
      const cwd = sessionCwd(agent)

      if (!(await isGitRepository(ctx, cwd))) {
        return { kind: 'error', text: 'Not a git repository. /review needs a Git working tree.' }
      }

      const parsed = parseReviewArgs(rawInput)
      if (parsed.kind === 'error') return { kind: 'error', text: parsed.message }

      const settings = config()

      // Refuse a second review on the same conversation, and refuse starting one
      // *inside* a review branch — that is what /end-review is for.
      const existing = activeReviews.get(agent.session.id)
      if (existing !== undefined) {
        return {
          kind: 'error',
          text: `A review is already active (${existing.label}). Use /end-review to finish it first.`,
        }
      }
      for (const review of activeReviews.values()) {
        if (review.reviewSessionId === agent.session.id) {
          return {
            kind: 'error',
            text: `This session is the review branch for ${review.label}. Use /end-review to finish it.`,
          }
        }
      }

      const extraInstruction = parsed.kind === 'menu' ? undefined : parsed.extraInstruction

      /** Resolve one directly-named target into a full review target. */
      const fromDirect = async (direct: Parameters<typeof resolveDirectTarget>[2]) => {
        const resolved = await resolveDirectTarget(ctx, cwd, direct, { signal })
        return resolved.kind === 'error' ? { error: resolved.message } : { target: resolved.target }
      }

      /** Validate GitHub access, confirm a clean tree, and check the PR out. */
      const fromPullRequest = async (reference: string) => {
        const resolved = await resolvePullRequestInfo(ctx, cwd, reference, { signal })
        if (resolved.kind === 'error') return { error: resolved.message }
        if (resolved.kind === 'blocked') return { error: resolved.message }
        if (resolved.target.type !== 'pullRequest') {
          return { error: 'Internal error: the PR target did not resolve.' }
        }

        // Re-check immediately before checkout: the first check can be minutes old.
        if (await prCheckoutBlocked(ctx, cwd)) {
          return { error: PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE }
        }
        const checkedOut = await checkoutPr(ctx, cwd, resolved.target.prNumber, { signal })
        if (!checkedOut.success) return { error: `Failed to checkout PR: ${checkedOut.error}` }
        return { target: resolved.target }
      }

      let target: ReviewTarget | undefined

      if (parsed.kind === 'target') {
        const outcome = await fromDirect(parsed.target)
        if ('error' in outcome) return { kind: 'error', text: outcome.error }
        target = outcome.target
      } else if (parsed.kind === 'pullRequest') {
        const outcome = await fromPullRequest(parsed.reference)
        if ('error' in outcome) return { kind: 'error', text: outcome.error }
        target = outcome.target
      }

      // No target named: ask, using pi-review's suggested default.
      if (target === undefined) {
        const suggested = await getSmartDefault(ctx, cwd)
        const chosen = await askChoice(ctx, agent, {
          id: MODE_QUESTION_ID,
          header: 'Code review',
          question: 'What should be reviewed?',
          detail: `Suggested: ${MODE_LABELS[suggested]}`,
          options: [
            { label: MODE_LABELS.uncommitted },
            { label: MODE_LABELS.baseBranch, description: 'Local branch comparison' },
            { label: MODE_LABELS.commit },
            { label: MODE_LABELS.pullRequest, description: 'Checked out locally with gh' },
            { label: MODE_LABELS.folder, description: 'Snapshot, not a diff' },
          ],
        }, signal)

        if (chosen.kind === 'unavailable') return { kind: 'error', text: NO_DIALOG_MESSAGE }
        if (chosen.kind === 'dismissed') return { kind: 'success', text: 'Review cancelled.' }

        if (chosen.value === MODE_LABELS.uncommitted) {
          target = { type: 'uncommitted' }
        } else if (chosen.value === MODE_LABELS.baseBranch) {
          const branch = await askText(ctx, agent, {
            id: BRANCH_QUESTION_ID,
            header: 'Base branch',
            question: 'Which branch should the changes be compared against?',
            detail: 'For example: main',
          }, signal)
          if (branch.kind === 'unavailable') return { kind: 'error', text: NO_DIALOG_MESSAGE }
          if (branch.kind === 'dismissed') return { kind: 'success', text: 'Review cancelled.' }
          const outcome = await fromDirect({ type: 'baseBranch', branch: branch.value })
          if ('error' in outcome) return { kind: 'error', text: outcome.error }
          target = outcome.target
        } else if (chosen.value === MODE_LABELS.commit) {
          const sha = await askText(ctx, agent, {
            id: COMMIT_QUESTION_ID,
            header: 'Commit',
            question: 'Which commit should be reviewed?',
            detail: 'A commit SHA, or a ref such as HEAD~1',
          }, signal)
          if (sha.kind === 'unavailable') return { kind: 'error', text: NO_DIALOG_MESSAGE }
          if (sha.kind === 'dismissed') return { kind: 'success', text: 'Review cancelled.' }
          const outcome = await fromDirect({ type: 'commit', sha: sha.value })
          if ('error' in outcome) return { kind: 'error', text: outcome.error }
          target = outcome.target
        } else if (chosen.value === MODE_LABELS.pullRequest) {
          const reference = await askText(ctx, agent, {
            id: PR_QUESTION_ID,
            header: 'Pull request',
            question: 'Which pull request should be reviewed?',
            detail: 'A number, or a GitHub PR URL',
          }, signal)
          if (reference.kind === 'unavailable') return { kind: 'error', text: NO_DIALOG_MESSAGE }
          if (reference.kind === 'dismissed') return { kind: 'success', text: 'Review cancelled.' }
          const outcome = await fromPullRequest(reference.value)
          if ('error' in outcome) return { kind: 'error', text: outcome.error }
          target = outcome.target
        } else if (chosen.value === MODE_LABELS.folder) {
          const answer = await askText(ctx, agent, {
            id: FOLDER_QUESTION_ID,
            header: 'Folders or files',
            question: 'Which paths should be reviewed?',
            detail: 'Comma-separated. This is a snapshot review, not a diff.',
          }, signal)
          if (answer.kind === 'unavailable') return { kind: 'error', text: NO_DIALOG_MESSAGE }
          if (answer.kind === 'dismissed') return { kind: 'success', text: 'Review cancelled.' }
          const paths = answer.value.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
          if (paths.length === 0) return { kind: 'success', text: 'Review cancelled.' }
          target = { type: 'folder', paths }
        } else {
          return { kind: 'success', text: 'Review cancelled.' }
        }
      }

      const label = describeTarget(target)
      const customInstructions = settings.customInstructions?.trim()

      // Assemble the prompt *before* forking, so a failure here cannot strand an
      // empty review session in the user's history.
      const projectGuidelines = cwd === undefined
        ? undefined
        : await loadProjectReviewGuidelines(cwd)

      const message = composeReviewMessage({
        target,
        customInstructions: customInstructions === '' ? undefined : customInstructions,
        extraInstruction,
        projectGuidelines,
      })

      const wantsBranch = settings.branchReview !== false
      const session = wantsBranch
        ? await createReviewSession(ctx, agent, undefined)
        : { sessionId: agent.session.id, forked: false }

      activeReviews.set(session.sessionId, {
        reviewSessionId: session.sessionId,
        originSessionId: agent.session.id,
        target,
        label,
      })

      if (!deliverReviewPrompt(ctx, agent, session.sessionId, message)) {
        activeReviews.delete(session.sessionId)
        return {
          kind: 'error',
          text: 'The review session could not be started. Try again, or set `branchReview: false` for this plugin to review in place.',
        }
      }

      if (session.forked) {
        setFocus(session.sessionId, 'review')
        return {
          kind: 'success',
          text: [
            `Starting review: ${label}`,
            'A review branch was created and the browser is switching to it.',
            'Finish with /end-review, which returns you to this conversation.',
          ].join('\n'),
        }
      }

      return {
        kind: 'success',
        text: [
          `Starting review: ${label}`,
          'Reviewing in this session (session branching is unavailable here).',
          'Use /end-review when it finishes.',
        ].join('\n'),
      }
    },
  })
}

/** Register `/end-review`. */
function registerEndReviewCommand(ctx: Context, config: () => Config): void {
  ctx.commands.register({
    name: 'end-review',
    description: 'Finish the active review and act on its findings',
    handler: async (invocation) => {
      const { agent, signal } = invocation
      const review = activeReviews.get(agent.session.id)

      if (review === undefined) {
        return {
          kind: 'error',
          text: 'No review is active in this session. Start one with /review.',
        }
      }

      const choice = await askChoice(ctx, agent, {
        id: END_QUESTION_ID,
        header: 'Finish review',
        question: `How should the review of ${review.label} be finished?`,
        options: [
          {
            label: END_LABELS.returnAndSummarize,
            description: 'Summarize the findings so they can be acted on.',
          },
          {
            label: END_LABELS.returnAndFix,
            description: 'Summarize the findings, then queue a follow-up turn that implements them.',
          },
          {
            label: END_LABELS.returnOnly,
            description: 'Finish the review without summarizing.',
          },
        ],
      }, signal)

      if (choice.kind === 'unavailable') {
        // Without a dialog there is no way to choose, and the review stays
        // active so the user can retry once a browser is attached.
        return { kind: 'error', text: NO_DIALOG_MESSAGE }
      }
      if (choice.kind === 'dismissed') {
        return { kind: 'success', text: 'Cancelled. Use /end-review to try again.' }
      }

      const wantsSummary =
        choice.value === END_LABELS.returnAndSummarize || choice.value === END_LABELS.returnAndFix

      if (wantsSummary) {
        // The reviewing agent produces the summary itself: it holds the findings
        // in context, and a second model re-reading the transcript would lose
        // exactly the detail the handoff exists to preserve. Two prompts are
        // queued in order, so the fix turn reads the summary the model just wrote.
        deliverReviewPrompt(ctx, agent, review.reviewSessionId, REVIEW_SUMMARY_PROMPT)
        if (choice.value === END_LABELS.returnAndFix) {
          deliverReviewPrompt(ctx, agent, review.reviewSessionId, REVIEW_FIX_FINDINGS_PROMPT)
        }
      }

      activeReviews.delete(agent.session.id)

      const returning = review.reviewSessionId !== review.originSessionId
      if (returning) setFocus(review.originSessionId, 'origin')

      const suffix = wantsSummary
        ? choice.value === END_LABELS.returnAndFix
          ? '\nThe findings are being summarized, then implemented in a follow-up turn.'
          : '\nThe findings are being summarized.'
        : ''

      return {
        kind: 'success',
        text: returning
          ? `Review finished (${review.label}).${suffix}\nReturning you to the original conversation; this review session stays in your history.`
          : `Review finished (${review.label}).${suffix}`,
      }
    },
  })
}

/** Current status document for the client half. */
function readStatus(): ReviewStatus {
  return {
    version: DSH_REVIEW_VERSION,
    active: [...activeReviews.values()].map(review => ({
      sessionId: String(review.reviewSessionId),
      originSessionId: String(review.originSessionId),
      label: review.label,
    })),
    ...focus === undefined ? {} : { focus },
  }
}

/**
 * Apply the review plugin.
 *
 * Registration is intentionally all-or-nothing for the two commands: `inject`
 * already guarantees the registries they need, so there is no partial mode to
 * reason about. Every other capability is optional and degrades in place.
 */
export function apply(ctx: Context, config: Config): void {
  let current = (): Config => config

  // Settings are optional: they carry the shared instructions and the branching
  // preference, and their absence just means the applied config stands.
  ctx.inject(['settings'], settingsCtx => {
    const scope = settingsCtx.settings.register(DSH_REVIEW_SETTINGS_NS, Config, { base: config })
    current = () => scope.get()
  })

  // The status route is optional too — a headless profile serves no browser, and
  // in that case the review still works; only the automatic session switch is
  // unavailable.
  ctx.inject(['webServer'], webCtx => {
    registerReviewStatusRoute(webCtx, readStatus)
  })

  registerReviewCommand(ctx, current)
  registerEndReviewCommand(ctx, current)

  ctx.effect(() => () => {
    activeReviews.clear()
    focus = undefined
  }, 'dsh-review: clear review state on unload')
}
