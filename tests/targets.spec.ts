import { describe, expect, it } from 'vitest'
import {
  BASE_BRANCH_PROMPT_FALLBACK,
  BASE_BRANCH_PROMPT_WITH_MERGE_BASE,
  COMMIT_PROMPT,
  COMMIT_PROMPT_WITH_TITLE,
  FOLDER_REVIEW_PROMPT,
  PULL_REQUEST_PROMPT,
  PULL_REQUEST_PROMPT_FALLBACK,
  REVIEW_FIX_FINDINGS_PROMPT,
  REVIEW_RUBRIC,
  REVIEW_SUMMARY_PROMPT,
  UNCOMMITTED_PROMPT,
} from '../src/prompts.ts'
import { buildReviewPrompt, composeReviewMessage, describeTarget } from '../src/targets.ts'

/**
 * Placeholders the review prompts use.
 *
 * A plain `/\{\w+\}/` scan is wrong here: the base-branch fallback legitimately
 * contains git's own `main@{upstream}` syntax once substituted, which looks like
 * a placeholder but is the literal command the model should run.
 */
const PLACEHOLDERS = [
  '{baseBranch}',
  '{mergeBaseSha}',
  '{branch}',
  '{sha}',
  '{title}',
  '{prNumber}',
  '{paths}',
] as const

/** Every prompt placeholder, substituted as `fill()` does (all occurrences). */
function expectNoPlaceholders(prompt: string): void {
  for (const placeholder of PLACEHOLDERS) {
    expect(prompt).not.toContain(placeholder)
  }
}

describe('buildReviewPrompt', () => {
  it('uses the merge-base wording when the merge base is known', () => {
    const prompt = buildReviewPrompt({ type: 'baseBranch', branch: 'main', mergeBaseSha: 'abc123' })
    expect(prompt).toBe(
      BASE_BRANCH_PROMPT_WITH_MERGE_BASE
        .replaceAll('{baseBranch}', 'main')
        .replaceAll('{mergeBaseSha}', 'abc123'),
    )
    expectNoPlaceholders(prompt)
  })

  it('uses the fallback wording when the merge base is unknown', () => {
    const prompt = buildReviewPrompt({ type: 'baseBranch', branch: 'main' })
    expect(prompt).toBe(BASE_BRANCH_PROMPT_FALLBACK.replaceAll('{branch}', 'main'))
    expectNoPlaceholders(prompt)
  })

  it('includes the commit subject only when one is known', () => {
    expect(buildReviewPrompt({ type: 'commit', sha: 'deadbee' })).toBe(
      COMMIT_PROMPT.replace('{sha}', 'deadbee'),
    )
    expect(buildReviewPrompt({ type: 'commit', sha: 'deadbee', title: 'Fix the thing' })).toBe(
      COMMIT_PROMPT_WITH_TITLE.replace('{sha}', 'deadbee').replace('{title}', 'Fix the thing'),
    )
  })

  it('fills every placeholder for a pull request, in both variants', () => {
    const withBase = buildReviewPrompt({
      type: 'pullRequest',
      prNumber: 42,
      baseBranch: 'main',
      title: 'Add review',
      mergeBaseSha: 'abc123',
    })
    expectNoPlaceholders(withBase)
    expect(withBase).toBe(
      PULL_REQUEST_PROMPT
        .replaceAll('{prNumber}', '42')
        .replaceAll('{title}', 'Add review')
        .replaceAll('{baseBranch}', 'main')
        .replaceAll('{mergeBaseSha}', 'abc123'),
    )

    const withoutBase = buildReviewPrompt({
      type: 'pullRequest',
      prNumber: 42,
      baseBranch: 'main',
      title: 'Add review',
    })
    expectNoPlaceholders(withoutBase)
    expect(withoutBase).toBe(
      PULL_REQUEST_PROMPT_FALLBACK
        .replaceAll('{prNumber}', '42')
        .replaceAll('{title}', 'Add review')
        .replaceAll('{baseBranch}', 'main'),
    )
  })

  it('lists folder paths and states the review is a snapshot', () => {
    const prompt = buildReviewPrompt({ type: 'folder', paths: ['src', 'docs'] })
    expect(prompt).toBe(FOLDER_REVIEW_PROMPT.replace('{paths}', 'src, docs'))
  })

  it('passes the uncommitted prompt through unchanged', () => {
    expect(buildReviewPrompt({ type: 'uncommitted' })).toBe(UNCOMMITTED_PROMPT)
  })

  it('never leaves a placeholder unresolved for any target', () => {
    const targets = [
      { type: 'uncommitted' as const },
      { type: 'baseBranch' as const, branch: 'main' },
      { type: 'baseBranch' as const, branch: 'main', mergeBaseSha: 'abc' },
      { type: 'commit' as const, sha: 'abc' },
      { type: 'commit' as const, sha: 'abc', title: 'T' },
      { type: 'folder' as const, paths: ['a'] },
      { type: 'pullRequest' as const, prNumber: 1, baseBranch: 'main', title: 'T' },
      { type: 'pullRequest' as const, prNumber: 1, baseBranch: 'main', title: 'T', mergeBaseSha: 'abc' },
    ]
    for (const target of targets) {
      expectNoPlaceholders(buildReviewPrompt(target))
    }
  })
})

describe('composeReviewMessage', () => {
  const target = { type: 'uncommitted' as const }

  it('always leads with the rubric and the focus prompt', () => {
    const message = composeReviewMessage({ target })
    expect(message.startsWith(REVIEW_RUBRIC)).toBe(true)
    expect(message).toContain('Please perform a code review with the following focus:')
    expect(message).toContain(UNCOMMITTED_PROMPT)
  })

  it('appends each optional instruction source only when supplied', () => {
    expect(composeReviewMessage({ target })).not.toContain('Shared custom review instructions')
    expect(composeReviewMessage({ target, customInstructions: 'Be terse' }))
      .toContain('Shared custom review instructions (applies to all reviews):\n\nBe terse')
    expect(composeReviewMessage({ target, extraInstruction: 'Focus on perf' }))
      .toContain('Additional user-provided review instruction:\n\nFocus on perf')
    expect(composeReviewMessage({ target, projectGuidelines: '# House rules' }))
      .toContain('This project has additional instructions for code reviews:\n\n# House rules')
  })

  it('ignores an empty or whitespace-only extra instruction', () => {
    expect(composeReviewMessage({ target, extraInstruction: '   ' }))
      .not.toContain('Additional user-provided review instruction')
  })

  it('orders the optional sections rubric → focus → custom → extra → project', () => {
    const message = composeReviewMessage({
      target,
      customInstructions: 'CUSTOM',
      extraInstruction: 'EXTRA',
      projectGuidelines: 'PROJECT',
    })
    const order = ['Please perform', 'CUSTOM', 'EXTRA', 'PROJECT'].map(marker => message.indexOf(marker))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every(index => index >= 0)).toBe(true)
  })

  it('exposes the summary and fix prompts the end-review flow queues', () => {
    expect(REVIEW_SUMMARY_PROMPT).toContain('## Review Scope')
    expect(REVIEW_SUMMARY_PROMPT).toContain('## Fix Queue')
    expect(REVIEW_FIX_FINDINGS_PROMPT).toContain('implement the review findings now')
  })
})

describe('describeTarget', () => {
  it('shortens a long PR title and a long folder list', () => {
    const long = describeTarget({
      type: 'pullRequest',
      prNumber: 7,
      baseBranch: 'main',
      title: 'A very long pull request title that should be truncated somewhere',
    })
    expect(long.startsWith('PR #7: ')).toBe(true)
    expect(long.endsWith('...')).toBe(true)

    const folders = describeTarget({ type: 'folder', paths: ['a/very/long/path', 'another/long/path'] })
    expect(folders.startsWith('folders: ')).toBe(true)
  })

  it('describes each mode in human terms', () => {
    expect(describeTarget({ type: 'uncommitted' })).toBe('current changes')
    expect(describeTarget({ type: 'baseBranch', branch: 'main' })).toBe("changes against 'main'")
    expect(describeTarget({ type: 'commit', sha: 'abcdef1234' })).toBe('commit abcdef1')
    expect(describeTarget({ type: 'commit', sha: 'abcdef1234', title: 'Fix' })).toBe('commit abcdef1: Fix')
  })
})
