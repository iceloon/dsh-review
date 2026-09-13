import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, inject, name } from '../src/index.ts'

/**
 * The plugin keeps its active-review map in module scope, keyed by session id.
 * That map lives as long as the loaded module — which, for a test file, is the
 * whole file — so session ids must be unique across every case here, not just
 * within one. The counter is therefore monotonic and never reset.
 */
let sessionCounter = 0
function nextSessionId(): string {
  sessionCounter += 1
  return `session-test-${sessionCounter}`
}

/**
 * Mount the plugin against a minimal fake host.
 *
 * This is the closest thing to a real mount that can run in a unit test: the
 * plugin's two hard dependencies (`commands`, `shell`) are provided as recording
 * doubles, so a test can assert what was registered and drive a handler directly.
 */
interface Harness {
  ctx: Context
  commands: Array<{ name: string; description: string; handler: (invocation: unknown) => unknown }>
  run: (command: string, args?: readonly string[], code?: number) => void
  calls: Array<{ command: string; workdir?: string }>
  shellThrows?: Error
}

function createHarness(options: { gitRepository?: boolean } = {}): Harness {
  const commands: Harness['commands'] = []
  const calls: Harness['calls'] = []
  const responses = new Map<string, { stdout: string; stderr: string; code: number }>()

  const ctx = new Context()

  const shell = {
    resolve: (request: { command: string; workdir?: string }) => request,
    run: async (spec: { command: string; workdir?: string }) => {
      calls.push({ command: spec.command, ...spec.workdir === undefined ? {} : { workdir: spec.workdir } })
      const key = spec.command
      const match = [...responses.entries()].find(([prefix]) => key.startsWith(prefix))
      const response = match?.[1] ?? { stdout: '', stderr: '', code: 1 }
      return {
        exitCode: response.code,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 1000,
        stdout: { text: response.stdout, truncated: false },
        stderr: { text: response.stderr, truncated: false },
      }
    },
    start: () => { throw new Error('not used') },
    sandboxMode: undefined,
  }

  const registry = {
    register: (definition: Harness['commands'][number]) => {
      commands.push(definition)
      return () => {}
    },
  }

  // Provide the two required services on the root context.
  ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('commands', registry)
  ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('shell', shell)

  const harness: Harness = {
    ctx,
    commands,
    calls,
    run: (command, _args, code = 0) => {
      responses.set(command, { stdout: '', stderr: '', code })
    },
  }

  if (options.gitRepository !== false) {
    responses.set("git 'rev-parse' '--git-dir'", { stdout: '.git', stderr: '', code: 0 })
  }

  return harness
}

/** A minimal agent double with just what the handlers touch. */
function fakeAgent(sessionId = nextSessionId()) {
  const followups: string[] = []
  const agent = {
    id: sessionId,
    session: {
      id: sessionId,
      header: { cwd: '/repo' },
      snapshotEvents: () => [{ type: 'turn/end', seq: 4 }],
    },
    followup: (message: { content: Array<{ type: string; text?: string }> }) => {
      const text = message.content.map(block => block.text ?? '').join('')
      followups.push(text)
    },
  }
  return { agent, followups }
}

describe('plugin shape', () => {
  it('declares the identity and dependencies the host needs', () => {
    expect(name).toBe('dsh-review')
    expect(inject).toEqual(['commands', 'shell'])
  })

  it('defaults branchReview to on and customInstructions to unset', () => {
    expect(Config({})).toEqual({ branchReview: true })
  })
})

describe('apply', () => {
  it('registers both human commands', () => {
    const harness = createHarness()
    apply(harness.ctx, Config({}))
    const names = harness.commands.map(command => command.name).sort()
    expect(names).toEqual(['end-review', 'review'])
  })

  it('describes each command for discovery UI', () => {
    const harness = createHarness()
    apply(harness.ctx, Config({}))
    for (const command of harness.commands) {
      expect(command.description.length).toBeGreaterThan(10)
    }
  })
})

describe('/review handler', () => {
  it('refuses outside a git repository', async () => {
    const harness = createHarness({ gitRepository: false })
    apply(harness.ctx, Config({}))
    const review = harness.commands.find(command => command.name === 'review')!
    const { agent } = fakeAgent()

    const result = await review.handler({ agent, rawInput: 'uncommitted', signal: new AbortController().signal }) as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Not a git repository')
  })

  it('reports a missing --extra value instead of starting a review', async () => {
    const harness = createHarness()
    apply(harness.ctx, Config({}))
    const review = harness.commands.find(command => command.name === 'review')!
    const { agent, followups } = fakeAgent()

    const result = await review.handler({ agent, rawInput: 'branch main --extra', signal: new AbortController().signal }) as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Missing value for --extra')
    expect(followups).toHaveLength(0)
  })

  it('delivers the review prompt for a named target', async () => {
    const harness = createHarness()
    apply(harness.ctx, Config({ branchReview: false }))
    const review = harness.commands.find(command => command.name === 'review')!
    const { agent, followups } = fakeAgent()

    const result = await review.handler({ agent, rawInput: 'uncommitted', signal: new AbortController().signal }) as { kind: string; text: string }

    expect(result.kind).toBe('success')
    expect(followups).toHaveLength(1)
    // The rubric leads, and the focus prompt names the mode.
    expect(followups[0]).toContain('# Review Guidelines')
    expect(followups[0]).toContain('staged, unstaged, and untracked files')
  })

  it('runs git through the session working directory', async () => {
    const harness = createHarness()
    apply(harness.ctx, Config({ branchReview: false }))
    const review = harness.commands.find(command => command.name === 'review')!
    const { agent } = fakeAgent()

    await review.handler({ agent, rawInput: 'uncommitted', signal: new AbortController().signal })

    expect(harness.calls.length).toBeGreaterThan(0)
    for (const call of harness.calls) {
      expect(call.workdir).toBe('/repo')
    }
  })

  it('refuses a second review in the same session', async () => {
    const harness = createHarness()
    apply(harness.ctx, Config({ branchReview: false }))
    const review = harness.commands.find(command => command.name === 'review')!
    const { agent } = fakeAgent()

    await review.handler({ agent, rawInput: 'uncommitted', signal: new AbortController().signal })
    const second = await review.handler({ agent, rawInput: 'uncommitted', signal: new AbortController().signal }) as { kind: string; text: string }

    expect(second.kind).toBe('error')
    expect(second.text).toContain('already active')
  })

  it('includes shared custom instructions when configured', async () => {
    const harness = createHarness()
    apply(harness.ctx, Config({ branchReview: false, customInstructions: 'Be terse' }))
    const review = harness.commands.find(command => command.name === 'review')!
    const { agent, followups } = fakeAgent()

    await review.handler({ agent, rawInput: 'uncommitted', signal: new AbortController().signal })

    expect(followups[0]).toContain('Shared custom review instructions')
    expect(followups[0]).toContain('Be terse')
  })
})

describe('/end-review handler', () => {
  it('reports when no review is active', async () => {
    const harness = createHarness()
    apply(harness.ctx, Config({}))
    const endReview = harness.commands.find(command => command.name === 'end-review')!
    const { agent } = fakeAgent()

    const result = await endReview.handler({ agent, rawInput: '', signal: new AbortController().signal }) as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toContain('No review is active')
  })

  it('keeps the review active when no dialog channel exists', async () => {
    const harness = createHarness()
    apply(harness.ctx, Config({ branchReview: false }))
    const review = harness.commands.find(command => command.name === 'review')!
    const endReview = harness.commands.find(command => command.name === 'end-review')!
    const { agent } = fakeAgent()
    const signal = new AbortController().signal

    await review.handler({ agent, rawInput: 'uncommitted', signal })

    // Without a channel the user cannot choose, so the review must survive:
    // clearing it would strand the findings with no way to summarize them.
    const ended = await endReview.handler({ agent, rawInput: '', signal }) as { kind: string; text: string }
    expect(ended.kind).toBe('error')
    expect(ended.text).toContain('no interactive question channel')

    // Still active, so a second /review is refused.
    const again = await review.handler({ agent, rawInput: 'uncommitted', signal }) as { kind: string; text: string }
    expect(again.kind).toBe('error')
    expect(again.text).toContain('already active')
  })
})

describe('state isolation', () => {
  it('keeps one session\'s review separate from another\'s', async () => {
    const harness = createHarness()
    apply(harness.ctx, Config({ branchReview: false }))
    const review = harness.commands.find(command => command.name === 'review')!
    const endReview = harness.commands.find(command => command.name === 'end-review')!
    const signal = new AbortController().signal

    const first = fakeAgent('session-isolation-one')
    const second = fakeAgent('session-isolation-two')

    await review.handler({ agent: first.agent, rawInput: 'uncommitted', signal })
    await review.handler({ agent: second.agent, rawInput: 'uncommitted', signal })

    // Ending one session's review must not clear the other's.
    await endReview.handler({ agent: first.agent, rawInput: '', signal })
    const stillActive = await review.handler({
      agent: second.agent,
      rawInput: 'uncommitted',
      signal,
    }) as { kind: string; text: string }

    expect(stillActive.kind).toBe('error')
    expect(stillActive.text).toContain('already active')
  })
})

describe('unload', () => {
  it('clears review state when the plugin unwinds', async () => {
    const harness = createHarness()
    apply(harness.ctx, Config({ branchReview: false }))
    const review = harness.commands.find(command => command.name === 'review')!
    const { agent } = fakeAgent()
    const signal = new AbortController().signal

    await review.handler({ agent, rawInput: 'uncommitted', signal })

    // Dispose the plugin's fiber: its `ctx.effect` disposer must clear the map,
    // so re-applying the plugin starts with no review in flight.
    await harness.ctx.fiber.dispose()
    const second = createHarness()
    apply(second.ctx, Config({ branchReview: false }))
    const reviewAgain = second.commands.find(command => command.name === 'review')!
    const result = await reviewAgain.handler({ agent, rawInput: 'uncommitted', signal }) as { kind: string }

    expect(result.kind).toBe('success')
  })
})

describe('no interactive channel', () => {
  it('tells the user to name a target instead of pretending they cancelled', async () => {
    const harness = createHarness()
    apply(harness.ctx, Config({ branchReview: false }))
    const review = harness.commands.find(command => command.name === 'review')!
    const { agent, followups } = fakeAgent()

    // No user-questions service is composed in this harness, so the picker
    // cannot be shown. Saying "cancelled" would leave the user retrying a
    // command that can never prompt.
    const result = await review.handler({
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    }) as { kind: string; text: string }

    expect(result.kind).toBe('error')
    expect(result.text).toContain('no interactive question channel')
    expect(result.text).toContain('/review uncommitted')
    expect(followups).toHaveLength(0)
  })
})
