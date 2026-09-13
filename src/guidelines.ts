/**
 * Project review guidelines and `/review` argument parsing.
 *
 * Both are ports of pi-review helpers. The guidelines loader keeps pi's search
 * rule exactly — walk up from the working directory until a directory containing
 * a `.pi` folder is found, and read `REVIEW_GUIDELINES.md` from *that* directory —
 * but adds `.dsh` as an equally valid anchor, because a project using this plugin
 * has no reason to carry a Pi marker file.
 *
 * @module dsh-review/guidelines
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/** Directories whose presence marks the root that owns the guidelines file. */
const ANCHOR_DIRECTORIES = ['.pi', '.dsh'] as const

/** The guidelines filename, unchanged from pi-review. */
export const REVIEW_GUIDELINES_FILENAME = 'REVIEW_GUIDELINES.md'

/**
 * Find and read the project's review guidelines.
 *
 * Walks up from `cwd` looking for a directory that holds an anchor directory
 * (`.pi` or `.dsh`). The first such directory is treated as the project root, and
 * `REVIEW_GUIDELINES.md` is read from it. This mirrors pi-review's rule that the
 * guidelines sit *beside* the marker rather than inside it.
 *
 * Returns `undefined` when no anchor exists, the file is absent, it is empty
 * after trimming, or it cannot be read — all of which mean "no project
 * guidelines", which is an ordinary state rather than an error.
 *
 * @param cwd - directory to start from; a relative path resolves against the process cwd.
 * @returns the trimmed guidelines text, or `undefined`.
 */
export async function loadProjectReviewGuidelines(cwd: string): Promise<string | undefined> {
  let current = path.resolve(cwd)

  for (;;) {
    for (const anchor of ANCHOR_DIRECTORIES) {
      const anchorPath = path.join(current, anchor)
      const anchorStats = await stat(anchorPath).catch(() => null)
      if (anchorStats?.isDirectory() !== true) continue

      // The anchor exists, so this directory is the project root: either its
      // guidelines file is the answer or the project has none. Continuing the
      // walk would read a *parent* project's guidelines, which is never right.
      const guidelinesPath = path.join(current, REVIEW_GUIDELINES_FILENAME)
      const guidelinesStats = await stat(guidelinesPath).catch(() => null)
      if (guidelinesStats?.isFile() !== true) return undefined

      const content = await readFile(guidelinesPath, 'utf8').catch(() => undefined)
      if (content === undefined) return undefined
      const trimmed = content.trim()
      return trimmed === '' ? undefined : trimmed
    }

    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Split a command line into tokens, honouring single and double quotes.
 *
 * A verbatim port of pi-review's tokenizer: whitespace separates tokens, quotes
 * group them, and a backslash escapes the next character *inside* quotes. This is
 * intentionally not a full shell grammar — `/review` arguments are paths, branch
 * names, and prose, not pipelines.
 */
export function tokenizeArgs(value: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === undefined) break

    if (quote !== null) {
      if (char === '\\' && index + 1 < value.length) {
        current += value[index + 1]
        index += 1
        continue
      }
      if (char === quote) {
        quote = null
        continue
      }
      current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current.length > 0) tokens.push(current)

  return tokens
}

/** A parsed `/review` invocation. */
export type ParsedReviewArgs =
  | { kind: 'menu'; extraInstruction?: string | undefined }
  | { kind: 'target'; target: DirectTarget; extraInstruction?: string | undefined }
  | { kind: 'pullRequest'; reference: string; extraInstruction?: string | undefined }
  | { kind: 'error'; message: string }

/** Targets a user can name directly, before any git lookup. */
export type DirectTarget =
  | { type: 'uncommitted' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string }
  | { type: 'folder'; paths: string[] }

/**
 * Parse `/review` arguments.
 *
 * Grammar, unchanged from pi-review:
 *
 * ```
 * /review                                   → menu
 * /review uncommitted                       → current changes
 * /review branch <name>                     → against a base branch
 * /review commit <sha> [title...]           → one commit
 * /review pr <number|url>                   → a GitHub pull request
 * /review folder <path> [path...]           → snapshot review
 * /review <anything> --extra "<text>"       → adds a one-off instruction
 * ```
 *
 * An unrecognized subcommand yields `menu` rather than an error, so a typo opens
 * the picker instead of dead-ending — pi-review's behavior.
 */
export function parseReviewArgs(rawInput: string): ParsedReviewArgs {
  if (rawInput.trim() === '') return { kind: 'menu' }

  const rawParts = tokenizeArgs(rawInput.trim())
  const parts: string[] = []
  let extraInstruction: string | undefined

  for (let index = 0; index < rawParts.length; index += 1) {
    const part = rawParts[index]
    if (part === undefined) continue

    if (part === '--extra') {
      const next = rawParts[index + 1]
      if (next === undefined) return { kind: 'error', message: 'Missing value for --extra' }
      extraInstruction = next
      index += 1
      continue
    }

    if (part.startsWith('--extra=')) {
      extraInstruction = part.slice('--extra='.length)
      continue
    }

    parts.push(part)
  }

  const withExtra = <T extends object>(value: T): T & { extraInstruction?: string | undefined } =>
    extraInstruction === undefined ? value : { ...value, extraInstruction }

  const [subcommand, ...rest] = parts
  if (subcommand === undefined) return withExtra({ kind: 'menu' as const })

  switch (subcommand.toLowerCase()) {
    case 'uncommitted':
      return withExtra({ kind: 'target' as const, target: { type: 'uncommitted' as const } })

    case 'branch': {
      const branch = rest[0]
      if (branch === undefined) return withExtra({ kind: 'menu' as const })
      return withExtra({ kind: 'target' as const, target: { type: 'baseBranch' as const, branch } })
    }

    case 'commit': {
      const sha = rest[0]
      if (sha === undefined) return withExtra({ kind: 'menu' as const })
      const title = rest.slice(1).join(' ')
      return withExtra({
        kind: 'target' as const,
        target: title === ''
          ? { type: 'commit' as const, sha }
          : { type: 'commit' as const, sha, title },
      })
    }

    case 'folder': {
      // The tokenizer already split the arguments, so each token is one path and
      // a quoted token keeps its spaces. pi-review rejoined the tokens and split
      // them again on commas only, which silently turned the documented
      // `folder src docs` into the single path "src docs".
      const paths = parseReviewPaths(rest.join('\n'))
      if (paths.length === 0) return withExtra({ kind: 'menu' as const })
      return withExtra({ kind: 'target' as const, target: { type: 'folder' as const, paths } })
    }

    case 'pr': {
      const reference = rest[0]
      if (reference === undefined) return withExtra({ kind: 'menu' as const })
      return withExtra({ kind: 'pullRequest' as const, reference })
    }

    default:
      return withExtra({ kind: 'menu' as const })
  }
}

/**
 * Split a folder-review argument into individual paths.
 *
 * Commas and newlines separate, matching pi-review: users type both `src docs`
 * and `src, docs` for the same intent.
 */
export function parseReviewPaths(value: string): string[] {
  return value
    .split(/[,\n]/u)
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}
