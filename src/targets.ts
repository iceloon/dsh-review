/**
 * Review targets: what a review is *about*, and the prompt that asks for it.
 *
 * Ported from pi-review's `ReviewTarget` union, `buildReviewPrompt`, and
 * `getUserFacingHint`, with two deliberate changes:
 *
 * 1. `buildReviewPrompt` is pure here. pi-review called `git` inside it to
 *    resolve the merge base; that work now happens while the target is being
 *    resolved, so the prompt builder has no I/O and can be tested directly.
 * 2. The PR variant carries its base branch and title, which pi-review had
 *    already fetched by the time it built the prompt.
 *
 * @module dsh-review/targets
 */

import {
  BASE_BRANCH_PROMPT_FALLBACK,
  BASE_BRANCH_PROMPT_WITH_MERGE_BASE,
  COMMIT_PROMPT,
  COMMIT_PROMPT_WITH_TITLE,
  FOLDER_REVIEW_PROMPT,
  PULL_REQUEST_PROMPT,
  PULL_REQUEST_PROMPT_FALLBACK,
  REVIEW_RUBRIC,
  UNCOMMITTED_PROMPT,
} from './prompts.ts'

/** One review target: the five modes pi-review supported. */
export type ReviewTarget =
  | { type: 'uncommitted' }
  | { type: 'baseBranch'; branch: string; mergeBaseSha?: string }
  | { type: 'commit'; sha: string; title?: string }
  | { type: 'pullRequest'; prNumber: number; baseBranch: string; title: string; mergeBaseSha?: string }
  | { type: 'folder'; paths: string[] }

/** Fill every `{name}` placeholder in one prompt template. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (match, key: string) => values[key] ?? match)
}

/**
 * Build the focus prompt for one target.
 *
 * The merge-base branches are the reason this is a function rather than a table:
 * when the merge base is known the prompt hands the model an exact SHA to diff,
 * and when it is not the prompt asks the model to derive it. Sending the
 * exact-SHA wording without a SHA would produce a prompt that names a commit
 * that does not exist.
 */
export function buildReviewPrompt(target: ReviewTarget): string {
  switch (target.type) {
    case 'uncommitted':
      return UNCOMMITTED_PROMPT

    case 'baseBranch':
      return target.mergeBaseSha === undefined
        ? fill(BASE_BRANCH_PROMPT_FALLBACK, { branch: target.branch })
        : fill(BASE_BRANCH_PROMPT_WITH_MERGE_BASE, {
          baseBranch: target.branch,
          mergeBaseSha: target.mergeBaseSha,
        })

    case 'commit':
      return target.title === undefined
        ? fill(COMMIT_PROMPT, { sha: target.sha })
        : fill(COMMIT_PROMPT_WITH_TITLE, { sha: target.sha, title: target.title })

    case 'pullRequest':
      return target.mergeBaseSha === undefined
        ? fill(PULL_REQUEST_PROMPT_FALLBACK, {
          prNumber: String(target.prNumber),
          title: target.title,
          baseBranch: target.baseBranch,
        })
        : fill(PULL_REQUEST_PROMPT, {
          prNumber: String(target.prNumber),
          title: target.title,
          baseBranch: target.baseBranch,
          mergeBaseSha: target.mergeBaseSha,
        })

    case 'folder':
      return fill(FOLDER_REVIEW_PROMPT, { paths: target.paths.join(', ') })
  }
}

/** Short human label for one target, used in notifications and dialogs. */
export function describeTarget(target: ReviewTarget): string {
  switch (target.type) {
    case 'uncommitted':
      return 'current changes'
    case 'baseBranch':
      return `changes against '${target.branch}'`
    case 'commit': {
      const short = target.sha.slice(0, 7)
      return target.title === undefined ? `commit ${short}` : `commit ${short}: ${target.title}`
    }
    case 'pullRequest': {
      const title = target.title.length > 30 ? `${target.title.slice(0, 27)}...` : target.title
      return `PR #${target.prNumber}: ${title}`
    }
    case 'folder': {
      const joined = target.paths.join(', ')
      return joined.length > 40 ? `folders: ${joined.slice(0, 37)}...` : `folders: ${joined}`
    }
  }
}

/**
 * Assemble the complete prompt sent to the model for one review.
 *
 * The order is pi-review's and matters: the rubric establishes the standard,
 * the focus narrows it to this target, then the three optional instruction
 * sources layer on top in increasing specificity — shared custom instructions,
 * the one-off `--extra`, and finally the project's own guidelines, which the
 * rubric explicitly says override it.
 */
export function composeReviewMessage(options: {
  target: ReviewTarget
  customInstructions?: string | undefined
  extraInstruction?: string | undefined
  projectGuidelines?: string | undefined
}): string {
  let message = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${buildReviewPrompt(options.target)}`

  if (options.customInstructions !== undefined && options.customInstructions !== '') {
    message += `\n\nShared custom review instructions (applies to all reviews):\n\n${options.customInstructions}`
  }

  if (options.extraInstruction !== undefined && options.extraInstruction.trim() !== '') {
    message += `\n\nAdditional user-provided review instruction:\n\n${options.extraInstruction.trim()}`
  }

  if (options.projectGuidelines !== undefined && options.projectGuidelines !== '') {
    message += `\n\nThis project has additional instructions for code reviews:\n\n${options.projectGuidelines}`
  }

  return message
}
