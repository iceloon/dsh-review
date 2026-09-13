/**
 * Review targets resolved against the working tree.
 *
 * pi-review resolved targets inline in its command handler, interleaving git
 * calls with UI prompts. Here the two are separated: this module answers "what
 * does the user's request mean in this repository", and the command handler
 * decides what to ask and what to say. That split is what makes the git
 * behavior testable without a UI.
 *
 * @module dsh-review/resolve
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  getCommitTitle,
  getMergeBase,
  getPrInfo,
  hasGithubCli,
  hasPendingChanges,
  isGithubAuthenticated,
  parsePrReference,
  type PullRequestInfo,
} from './git.ts'
import type { DirectTarget } from './guidelines.ts'
import type { ReviewTarget } from './targets.ts'

/** Guidance shown when `gh` is missing, unchanged from pi-review. */
export const GH_SETUP_INSTRUCTIONS =
  'Install GitHub CLI (`gh`) from https://cli.github.com/ (macOS: `brew install gh`), then sign in with `gh auth login` and verify with `gh auth status`.'

/** Message shown when a PR cannot be checked out over local edits. */
export const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE =
  'Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.'

/** Result of resolving a direct target, before any git lookup. */
export type ResolveResult =
  | { kind: 'ok'; target: ReviewTarget }
  | { kind: 'error'; message: string }

/**
 * Enrich a directly-parsed target with the git facts its prompt needs.
 *
 * Only two of the five modes need any lookup: a base-branch review wants the
 * merge base so the prompt can name an exact SHA, and a commit review wants the
 * subject. Both lookups are optional — their absence selects the fallback
 * wording rather than failing, which is what keeps review working in a shallow
 * clone or a repository with no upstream.
 */
export async function resolveDirectTarget(
  ctx: Context,
  cwd: string | undefined,
  direct: DirectTarget,
  options: { signal?: AbortSignal } = {},
): Promise<ResolveResult> {
  switch (direct.type) {
    case 'uncommitted':
      return { kind: 'ok', target: { type: 'uncommitted' } }

    case 'baseBranch': {
      const mergeBaseSha = await getMergeBase(ctx, cwd, direct.branch, options)
      return {
        kind: 'ok',
        target: mergeBaseSha === null
          ? { type: 'baseBranch', branch: direct.branch }
          : { type: 'baseBranch', branch: direct.branch, mergeBaseSha },
      }
    }

    case 'commit': {
      if (direct.title !== undefined) {
        return { kind: 'ok', target: { type: 'commit', sha: direct.sha, title: direct.title } }
      }
      const title = await getCommitTitle(ctx, cwd, direct.sha, options)
      return {
        kind: 'ok',
        target: title === undefined
          ? { type: 'commit', sha: direct.sha }
          : { type: 'commit', sha: direct.sha, title },
      }
    }

    case 'folder':
      return { kind: 'ok', target: { type: 'folder', paths: direct.paths } }
  }
}

/** Why a pull-request target could not be prepared. */
export type PrResolution =
  | { kind: 'ok'; target: ReviewTarget; info: PullRequestInfo }
  | { kind: 'error'; message: string }
  | { kind: 'blocked'; message: string }

/**
 * Validate GitHub access and read PR metadata, without checking anything out.
 *
 * Split from the checkout itself because pi-review asked a different question at
 * each point: access and metadata are checked first so a missing `gh` fails
 * before the user is asked to confirm anything, and the clean-tree check runs
 * again immediately before the checkout, since the first check can be minutes
 * old by then.
 */
export async function resolvePullRequestInfo(
  ctx: Context,
  cwd: string | undefined,
  reference: string,
  options: { signal?: AbortSignal } = {},
): Promise<PrResolution> {
  if (!(await hasGithubCli(ctx, cwd))) {
    return { kind: 'error', message: `PR review requires GitHub CLI (\`gh\`). ${GH_SETUP_INSTRUCTIONS}` }
  }

  if (!(await isGithubAuthenticated(ctx, cwd))) {
    return {
      kind: 'error',
      message: 'GitHub CLI is installed, but you are not signed in. Run `gh auth login`, then verify with `gh auth status`.',
    }
  }

  const prNumber = parsePrReference(reference)
  if (prNumber === null) {
    return { kind: 'error', message: 'Invalid PR reference. Enter a number or GitHub PR URL.' }
  }

  if (await hasPendingChanges(ctx, cwd)) {
    return { kind: 'blocked', message: PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE }
  }

  const info = await getPrInfo(ctx, cwd, prNumber, options)
  if (info === null) {
    return {
      kind: 'error',
      message: `Could not fetch PR #${prNumber}. Make sure it exists and your GitHub auth has access (check with \`gh auth status\`).`,
    }
  }

  const mergeBaseSha = await getMergeBase(ctx, cwd, info.baseBranch, options)

  return {
    kind: 'ok',
    info,
    target: mergeBaseSha === null
      ? {
        type: 'pullRequest',
        prNumber,
        baseBranch: info.baseBranch,
        title: info.title,
      }
      : {
        type: 'pullRequest',
        prNumber,
        baseBranch: info.baseBranch,
        title: info.title,
        mergeBaseSha,
      },
  }
}

/**
 * Whether tracked files have changes that would block a PR checkout.
 *
 * Exposed separately so the caller can re-check immediately before checking out,
 * which is the check that actually protects the user's work.
 */
export async function prCheckoutBlocked(ctx: Context, cwd: string | undefined): Promise<boolean> {
  return hasPendingChanges(ctx, cwd)
}
