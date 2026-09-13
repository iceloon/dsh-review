/**
 * Git and GitHub CLI access for the review workflow.
 *
 * pi-review called `pi.exec(argv)` and read `{ code, stdout, stderr }`. DSH has
 * no argv-level exec: `ctx.shell` takes a command line, so every invocation here
 * is built as a POSIX-quoted string and run through the same executor the `bash`
 * tool uses — which means it inherits the session's sandbox policy rather than
 * reaching around it.
 *
 * Every function in this module is deliberately non-throwing about *git* errors
 * (a missing repo, a detached HEAD, an absent `gh`): those are ordinary answers
 * the review flow branches on. A failure to run the command at all is different
 * and does surface, because that means the shell capability itself is broken.
 *
 * @module dsh-review/git
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell'

/** Result of one command, mirroring the `{ code, stdout, stderr }` shape pi used. */
export interface ExecResult {
  /** Process exit code; `null` when the process died from a signal. */
  code: number | null
  stdout: string
  stderr: string
}

/** A commit as shown in the picker. */
export interface CommitInfo {
  sha: string
  title: string
}

/** Pull-request metadata read from `gh`. */
export interface PullRequestInfo {
  baseBranch: string
  title: string
  headBranch: string
}

/**
 * Quote one argument for POSIX `sh`.
 *
 * Single quotes are literal in POSIX shell, so wrapping is safe for everything
 * except a single quote itself, which is closed, escaped, and reopened. This is
 * the standard `'\''` idiom. Windows is out of scope: the review flow's `gh`
 * dependency is POSIX-oriented and the plugin documents that.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Run one command through the session's shell executor.
 *
 * `ctx.shell.resolve()` applies the implementation's own workdir default and
 * timeout cap, so this never invents its own limits. Nonzero exits resolve
 * normally, exactly as the `bash` tool sees them.
 */
export async function runCommand(
  ctx: Context,
  cwd: string | undefined,
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const request = {
    command,
    ...cwd === undefined ? {} : { workdir: cwd },
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ...options.signal === undefined ? {} : { signal: options.signal },
  }
  const result = await ctx.shell.run(ctx.shell.resolve(request))
  return {
    code: result.exitCode,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
  }
}

/** Run one argv-style git invocation. */
function git(ctx: Context, cwd: string | undefined, args: readonly string[], options?: { signal?: AbortSignal }): Promise<ExecResult> {
  return runCommand(ctx, cwd, `git ${args.map(shellQuote).join(' ')}`, options)
}

/** Run one argv-style `gh` invocation. */
function gh(ctx: Context, cwd: string | undefined, args: readonly string[], options?: { signal?: AbortSignal }): Promise<ExecResult> {
  return runCommand(ctx, cwd, `gh ${args.map(shellQuote).join(' ')}`, options)
}

/**
 * Whether `cwd` is inside a git work tree.
 *
 * `rev-parse --git-dir` succeeds in a bare repo and in a subdirectory of a work
 * tree, which is the check pi used and the right one here: the review flow needs
 * a repository, not a specific layout.
 */
export async function isGitRepository(ctx: Context, cwd: string | undefined): Promise<boolean> {
  const { code } = await git(ctx, cwd, ['rev-parse', '--git-dir'])
  return code === 0
}

/**
 * The merge base between `HEAD` and `branch`.
 *
 * Tries the branch's upstream first (the PR-style comparison a feature branch
 * usually wants) and falls back to the branch name itself. Returns `null` when
 * neither resolves — the caller then uses the fallback prompt that asks the
 * model to find the merge base, rather than guessing one here.
 */
export async function getMergeBase(
  ctx: Context,
  cwd: string | undefined,
  branch: string,
  options?: { signal?: AbortSignal },
): Promise<string | null> {
  const upstream = await git(ctx, cwd, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], options)
  if (upstream.code === 0 && upstream.stdout.trim() !== '') {
    const mergeBase = await git(ctx, cwd, ['merge-base', 'HEAD', upstream.stdout.trim()], options)
    if (mergeBase.code === 0 && mergeBase.stdout.trim() !== '') return mergeBase.stdout.trim()
  }

  const direct = await git(ctx, cwd, ['merge-base', 'HEAD', branch], options)
  if (direct.code === 0 && direct.stdout.trim() !== '') return direct.stdout.trim()

  return null
}

/** Local branch names, in `git branch` order. Empty when not a repository. */
export async function getLocalBranches(ctx: Context, cwd: string | undefined): Promise<string[]> {
  const { stdout, code } = await git(ctx, cwd, ['branch', '--format=%(refname:short)'])
  if (code !== 0) return []
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}

/**
 * The most recent commits, newest first.
 *
 * `--oneline` output is `sha subject`; the subject is rejoined from the
 * remaining fields so a commit whose message contains spaces survives intact.
 */
export async function getRecentCommits(
  ctx: Context,
  cwd: string | undefined,
  limit = 10,
): Promise<CommitInfo[]> {
  const { stdout, code } = await git(ctx, cwd, ['log', '--oneline', '-n', String(limit)])
  if (code !== 0) return []
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => {
      const space = line.indexOf(' ')
      if (space === -1) return { sha: line, title: '' }
      return { sha: line.slice(0, space), title: line.slice(space + 1) }
    })
}

/** Whether the working tree has any change at all, including untracked files. */
export async function hasUncommittedChanges(ctx: Context, cwd: string | undefined): Promise<boolean> {
  const { stdout, code } = await git(ctx, cwd, ['status', '--porcelain'])
  return code === 0 && stdout.trim() !== ''
}

/**
 * Whether tracked files have staged or unstaged changes.
 *
 * Untracked files do not block a branch switch, so `??` lines are ignored —
 * the distinction pi-review drew, and the reason a PR can be checked out over a
 * tree that only holds new scratch files.
 */
export async function hasPendingChanges(ctx: Context, cwd: string | undefined): Promise<boolean> {
  const { stdout, code } = await git(ctx, cwd, ['status', '--porcelain'])
  if (code !== 0) return false
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .some(line => !line.startsWith('??'))
}

/** The current branch name, or `null` on a detached HEAD. */
export async function getCurrentBranch(ctx: Context, cwd: string | undefined): Promise<string | null> {
  const { stdout, code } = await git(ctx, cwd, ['branch', '--show-current'])
  if (code === 0 && stdout.trim() !== '') return stdout.trim()
  return null
}

/**
 * The repository's default branch.
 *
 * Prefers `origin/HEAD` — the only source that is right for a repository whose
 * default is neither `main` nor `master` — then the two conventional names, then
 * `main` as pi-review did.
 */
export async function getDefaultBranch(ctx: Context, cwd: string | undefined): Promise<string> {
  const { stdout, code } = await git(ctx, cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'])
  if (code === 0 && stdout.trim() !== '') return stdout.trim().replace(/^origin\//u, '')

  const branches = await getLocalBranches(ctx, cwd)
  if (branches.includes('main')) return 'main'
  if (branches.includes('master')) return 'master'

  return 'main'
}

/**
 * Extract a pull-request number from a number or a GitHub PR URL.
 *
 * Accepts `123`, `https://github.com/owner/repo/pull/123`, and the same URL
 * without a scheme, matching pi-review's grammar.
 */
export function parsePrReference(reference: string): number | null {
  const trimmed = reference.trim()

  if (/^\d+$/u.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10)
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }

  const match = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/u)
  if (match?.[1] !== undefined) {
    const value = Number.parseInt(match[1], 10)
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }

  return null
}

/** Whether the GitHub CLI is installed. */
export async function hasGithubCli(ctx: Context, cwd: string | undefined): Promise<boolean> {
  const { code } = await gh(ctx, cwd, ['--version'])
  return code === 0
}

/** Whether `gh` holds a usable credential. */
export async function isGithubAuthenticated(ctx: Context, cwd: string | undefined): Promise<boolean> {
  const { code } = await gh(ctx, cwd, ['auth', 'status'])
  return code === 0
}

/**
 * Read one pull request's base branch, title, and head branch.
 *
 * Returns `null` on any failure — absent PR, no access, malformed JSON — because
 * every one of those is reported to the user by the caller as the same
 * actionable "could not fetch PR" outcome.
 */
export async function getPrInfo(
  ctx: Context,
  cwd: string | undefined,
  prNumber: number,
  options?: { signal?: AbortSignal },
): Promise<PullRequestInfo | null> {
  const { stdout, code } = await gh(
    ctx,
    cwd,
    ['pr', 'view', String(prNumber), '--json', 'baseRefName,title,headRefName'],
    options,
  )
  if (code !== 0) return null

  try {
    const data: unknown = JSON.parse(stdout)
    if (typeof data !== 'object' || data === null) return null
    const record = data as Record<string, unknown>
    const baseBranch = record['baseRefName']
    const title = record['title']
    const headBranch = record['headRefName']
    if (typeof baseBranch !== 'string' || typeof title !== 'string' || typeof headBranch !== 'string') {
      return null
    }
    return { baseBranch, title, headBranch }
  } catch {
    return null
  }
}

/** Check out a pull request locally. Returns the failure text on nonzero exit. */
export async function checkoutPr(
  ctx: Context,
  cwd: string | undefined,
  prNumber: number,
  options?: { signal?: AbortSignal },
): Promise<{ success: true } | { success: false; error: string }> {
  const { stdout, stderr, code } = await gh(ctx, cwd, ['pr', 'checkout', String(prNumber)], options)
  if (code !== 0) {
    const detail = stderr.trim() !== '' ? stderr : stdout
    return { success: false, error: detail.trim() !== '' ? detail.trim() : 'Failed to checkout PR' }
  }
  return { success: true }
}

/** The commit subject for one sha, or `undefined` when it does not resolve. */
export async function getCommitTitle(
  ctx: Context,
  cwd: string | undefined,
  sha: string,
  options?: { signal?: AbortSignal },
): Promise<string | undefined> {
  const { stdout, code } = await git(ctx, cwd, ['log', '-1', '--format=%s', sha], options)
  if (code !== 0) return undefined
  const title = stdout.trim()
  return title === '' ? undefined : title
}
