// Tests for the todo-enforcer idle hook. Run: node --test index.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.js'

// The plugin exports only its definition, so drive it through the hook it
// registers. That is also what OpenCode does.
async function harness({ messages = [], goal, options } = {}) {
  let idle
  const synthetic = []
  const ctx = {
    options,
    session: {
      hook: async (name, cb) => {
        if (name === 'experimental.idle') idle = cb
        return { dispose: async () => {} }
      },
      context: typeof messages === 'function' ? messages : async () => ({ data: messages }),
      synthetic: async (input) => {
        synthetic.push(input)
      },
    },
    storage: {
      get: async (key) => {
        if (key !== 'session:s1') return undefined
        return goal
      },
    },
  }
  await plugin.setup(ctx)
  assert.equal(typeof idle, 'function', 'experimental.idle must be registered')
  const fire = (background = []) => idle({ sessionID: 's1', background })
  return { fire, synthetic }
}

function assistant(todos, name = 'todowrite', status = 'completed') {
  return {
    type: 'assistant',
    content: [{ type: 'tool', name, state: { status, input: { todos } } }],
  }
}

test('resumes once for a session with one open todo', async () => {
  const h = await harness({ messages: [assistant([{ content: 'write the docs', status: 'pending' }])] })
  await h.fire()
  assert.equal(h.synthetic.length, 1)
  assert.match(h.synthetic[0].text, /write the docs/)
  assert.match(h.synthetic[0].text, /pending/)
  assert.deepEqual(h.synthetic[0].metadata, { source: 'todo-enforcer' })
  assert.equal(h.synthetic[0].sessionID, 's1')
})

test('does not resume when every todo is completed or cancelled', async () => {
  const h = await harness({
    messages: [
      assistant([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'cancelled' },
      ]),
    ],
  })
  await h.fire()
  assert.equal(h.synthetic.length, 0)
})

test('does not resume when there are no todos', async () => {
  const h = await harness({ messages: [{ type: 'assistant', content: [{ type: 'text', text: 'hi' }] }] })
  await h.fire()
  assert.equal(h.synthetic.length, 0)
})

// A set that changes on every read, so the stall check never fires and only
// the cap can stop the loop.
function changingTodos(prefix) {
  let n = 0
  return async () => {
    n++
    return [assistant([{ content: `${prefix} ${n}`, status: 'pending' }])]
  }
}

test('stops at maxResumes', async () => {
  const h = await harness({ messages: changingTodos('step'), options: { maxResumes: 3 } })
  for (let i = 0; i < 10; i++) await h.fire()
  assert.equal(h.synthetic.length, 3)
})

test('defaults to 5 resumes', async () => {
  const h = await harness({ messages: changingTodos('step') })
  for (let i = 0; i < 10; i++) await h.fire()
  assert.equal(h.synthetic.length, 5)
})

test('stops when the remaining todos did not change', async () => {
  const h = await harness({ messages: [assistant([{ content: 'same', status: 'pending' }])] })
  await h.fire()
  await h.fire()
  await h.fire()
  assert.equal(h.synthetic.length, 1)
})

test('resumes again once the remaining set changes', async () => {
  const todos = [
    { content: 'alpha', status: 'pending' },
    { content: 'beta', status: 'pending' },
  ]
  const h = await harness({ messages: [assistant(todos)] })
  await h.fire()
  todos[0].status = 'completed'
  await h.fire()
  assert.equal(h.synthetic.length, 2)
  assert.doesNotMatch(h.synthetic[1].text, /alpha/)
  assert.match(h.synthetic[1].text, /beta/)
})

test('an active /goal means no resume', async () => {
  const h = await harness({
    messages: [assistant([{ content: 'open', status: 'pending' }])],
    goal: { status: 'active' },
  })
  await h.fire()
  assert.equal(h.synthetic.length, 0)
})

test('a paused /goal does not block the resume', async () => {
  const h = await harness({
    messages: [assistant([{ content: 'open', status: 'pending' }])],
    goal: { status: 'paused' },
  })
  await h.fire()
  assert.equal(h.synthetic.length, 1)
})

test('a background subagent for this session means no resume', async () => {
  const h = await harness({ messages: [assistant([{ content: 'open', status: 'pending' }])] })
  await h.fire([{ kind: 'subagent', sessionID: 's1' }])
  assert.equal(h.synthetic.length, 0)
})

test('a background item of another session does not block', async () => {
  const h = await harness({ messages: [assistant([{ content: 'open', status: 'pending' }])] })
  await h.fire([{ kind: 'subagent', sessionID: 'other' }])
  assert.equal(h.synthetic.length, 1)
})

test('a malformed context list neither throws nor resumes', async () => {
  for (const messages of [
    null,
    'not a list',
    42,
    { data: 'nope' },
    [{ type: 'assistant', content: [{ type: 'tool', name: 'todowrite' }] }],
    [{ type: 'assistant', content: [{ type: 'tool', name: 'todowrite', state: {} }] }],
    [{ type: 'assistant', content: [{ type: 'tool', name: 'todowrite', state: { status: 'completed' } }] }],
    [assistant([{ content: 'x', status: 'pending' }], 'todowrite', 'running')],
  ]) {
    const h = await harness({ messages })
    await h.fire()
    assert.equal(h.synthetic.length, 0, `must not resume for ${JSON.stringify(messages)}`)
  }
})

test('reads todos from the raw { data } envelope the client returns', async () => {
  const h = await harness({
    messages: async () => ({ data: [assistant([{ content: 'wrapped', status: 'pending' }])] }),
  })
  await h.fire()
  assert.equal(h.synthetic.length, 1)
  assert.match(h.synthetic[0].text, /wrapped/)
})

test('uses the last completed todowrite', async () => {
  const h = await harness({
    messages: [
      assistant([{ content: 'stale', status: 'pending' }]),
      assistant([{ content: 'fresh', status: 'completed' }]),
    ],
  })
  await h.fire()
  assert.equal(h.synthetic.length, 0)
})

test('swallows a throwing session.context', async () => {
  let idle
  const ctx = {
    session: {
      hook: async (name, cb) => {
        if (name === 'experimental.idle') idle = cb
        return { dispose: async () => {} }
      },
      message: {
        list: async () => {
          throw new Error('boom')
        },
      },
      synthetic: async () => {
        throw new Error('must not be called')
      },
    },
    storage: {
      get: async () => undefined,
    },
  }
  await plugin.setup(ctx)
  await idle({ sessionID: 's1', background: [] })
})
