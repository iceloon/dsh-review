import { describe, expect, it } from 'vitest'
import { parseReviewArgs, parseReviewPaths, tokenizeArgs } from '../src/guidelines.ts'
import { parsePrReference, shellQuote } from '../src/git.ts'

describe('tokenizeArgs', () => {
  it('splits on whitespace', () => {
    expect(tokenizeArgs('branch main')).toEqual(['branch', 'main'])
  })

  it('keeps a quoted value as one token', () => {
    expect(tokenizeArgs('folder "src/my dir" docs')).toEqual(['folder', 'src/my dir', 'docs'])
    expect(tokenizeArgs("folder 'src/my dir'")).toEqual(['folder', 'src/my dir'])
  })

  it('honours a backslash escape inside quotes', () => {
    expect(tokenizeArgs('"a\\"b"')).toEqual(['a"b'])
  })

  it('collapses repeated whitespace and trims edges', () => {
    expect(tokenizeArgs('  a   b  ')).toEqual(['a', 'b'])
  })

  it('returns nothing for an empty string', () => {
    expect(tokenizeArgs('')).toEqual([])
  })
})

describe('parseReviewArgs', () => {
  it('opens the menu when no arguments are given', () => {
    expect(parseReviewArgs('')).toEqual({ kind: 'menu' })
    expect(parseReviewArgs('   ')).toEqual({ kind: 'menu' })
  })

  it('parses each named mode', () => {
    expect(parseReviewArgs('uncommitted')).toEqual({
      kind: 'target',
      target: { type: 'uncommitted' },
    })
    expect(parseReviewArgs('branch main')).toEqual({
      kind: 'target',
      target: { type: 'baseBranch', branch: 'main' },
    })
    expect(parseReviewArgs('commit abc123')).toEqual({
      kind: 'target',
      target: { type: 'commit', sha: 'abc123' },
    })
    expect(parseReviewArgs('commit abc123 Fix the thing')).toEqual({
      kind: 'target',
      target: { type: 'commit', sha: 'abc123', title: 'Fix the thing' },
    })
    expect(parseReviewArgs('pr 42')).toEqual({ kind: 'pullRequest', reference: '42' })
    expect(parseReviewArgs('folder src docs')).toEqual({
      kind: 'target',
      target: { type: 'folder', paths: ['src', 'docs'] },
    })
  })

  it('treats each folder token as its own path', () => {
    // Regression: pi-review rejoined the tokens and re-split on commas only, so
    // the documented `folder src docs` became the single path "src docs".
    expect(parseReviewArgs('folder src docs')).toEqual({
      kind: 'target',
      target: { type: 'folder', paths: ['src', 'docs'] },
    })
    expect(parseReviewArgs('folder src,docs')).toEqual({
      kind: 'target',
      target: { type: 'folder', paths: ['src', 'docs'] },
    })
    // A quoted token keeps its spaces as one path.
    expect(parseReviewArgs('folder "my dir"')).toEqual({
      kind: 'target',
      target: { type: 'folder', paths: ['my dir'] },
    })
  })

  it('is case-insensitive on the subcommand', () => {
    expect(parseReviewArgs('UNCOMMITTED')).toEqual({
      kind: 'target',
      target: { type: 'uncommitted' },
    })
  })

  it('captures --extra in both spellings', () => {
    expect(parseReviewArgs('branch main --extra "focus on perf"')).toEqual({
      kind: 'target',
      target: { type: 'baseBranch', branch: 'main' },
      extraInstruction: 'focus on perf',
    })
    expect(parseReviewArgs('uncommitted --extra "focus on perf"')).toEqual({
      kind: 'target',
      target: { type: 'uncommitted' },
      extraInstruction: 'focus on perf',
    })
  })

  it('takes only the first token after --extra=, as upstream did', () => {
    // `--extra=<value>` is a single token, so an unquoted multi-word value is
    // truncated at the first space and the remainder becomes ordinary
    // arguments. Quoting is the documented way to pass a phrase.
    expect(parseReviewArgs('uncommitted --extra=focus on perf')).toEqual({
      kind: 'target',
      target: { type: 'uncommitted' },
      extraInstruction: 'focus',
    })
    expect(parseReviewArgs('uncommitted --extra="focus on perf"')).toEqual({
      kind: 'target',
      target: { type: 'uncommitted' },
      extraInstruction: 'focus on perf',
    })
  })

  it('reports a missing --extra value rather than guessing', () => {
    expect(parseReviewArgs('branch main --extra')).toEqual({
      kind: 'error',
      message: 'Missing value for --extra',
    })
  })

  it('falls back to the menu when a subcommand is incomplete', () => {
    // A typo opens the picker instead of dead-ending the user.
    expect(parseReviewArgs('branch')).toEqual({ kind: 'menu' })
    expect(parseReviewArgs('commit')).toEqual({ kind: 'menu' })
    expect(parseReviewArgs('pr')).toEqual({ kind: 'menu' })
    expect(parseReviewArgs('nonsense')).toEqual({ kind: 'menu' })
  })

  it('keeps --extra even when no target was named', () => {
    expect(parseReviewArgs('--extra "be terse"')).toEqual({
      kind: 'menu',
      extraInstruction: 'be terse',
    })
  })
})

describe('parseReviewPaths', () => {
  it('splits on commas and newlines and trims', () => {
    expect(parseReviewPaths('src, docs')).toEqual(['src', 'docs'])
    expect(parseReviewPaths('src\ndocs')).toEqual(['src', 'docs'])
    expect(parseReviewPaths(' src , docs ')).toEqual(['src', 'docs'])
  })

  it('drops empty entries', () => {
    expect(parseReviewPaths('src,,docs,')).toEqual(['src', 'docs'])
    expect(parseReviewPaths('   ')).toEqual([])
  })
})

describe('parsePrReference', () => {
  it('accepts a bare number', () => {
    expect(parsePrReference('123')).toBe(123)
    expect(parsePrReference('  42  ')).toBe(42)
  })

  it('accepts a GitHub PR URL, with or without a scheme', () => {
    expect(parsePrReference('https://github.com/owner/repo/pull/123')).toBe(123)
    expect(parsePrReference('github.com/owner/repo/pull/7')).toBe(7)
    expect(parsePrReference('http://github.com/a/b/pull/9/files')).toBe(9)
  })

  it('rejects anything else', () => {
    expect(parsePrReference('')).toBeNull()
    expect(parsePrReference('abc')).toBeNull()
    expect(parsePrReference('0')).toBeNull()
    expect(parsePrReference('-5')).toBeNull()
    expect(parsePrReference('https://github.com/owner/repo/issues/123')).toBeNull()
  })
})

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('main')).toBe("'main'")
  })

  it('escapes an embedded single quote with the close-escape-reopen idiom', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it('leaves shell metacharacters inert', () => {
    // The point of quoting: these must survive as literal text.
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'")
    expect(shellQuote('a; b | c && d')).toBe("'a; b | c && d'")
  })
})
