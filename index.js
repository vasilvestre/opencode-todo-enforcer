// opencode-todo-enforcer — OpenCode v2 plugin.
//
// When the session goes idle with todos still open, resume it once with the
// list of what is left. The agent either finishes them or marks them cancelled.
//
// There is no todo endpoint in v2.2.5. The source is the last completed
// `todowrite` tool call, the same one the TUI reads.
//
// The handler runs inside the session runner. It never throws: a broken lookup
// must not stop the session from going idle.

const DEFAULT_MAX_RESUMES = 5
const DONE = new Set(['completed', 'cancelled'])

// The idle event carries the running background items. /goal skips on the same
// check: a subagent or an image still working for this session means the turn
// is not really over.
function blockedByBackground(background, sessionID) {
  if (!Array.isArray(background)) return false
  return background.some(
    (b) => (b?.kind === 'subagent' || b?.kind === 'image') && b.sessionID === sessionID,
  )
}

// session.context returns { data } holding the active context messages (all
// messages after the last compaction). A message carries its parts in
// `content`. Anything else means "no todos".
function partsOf(messages) {
  const list = Array.isArray(messages) ? messages : messages?.data
  if (!Array.isArray(list)) return []
  return list.flatMap((m) => {
    const content = m?.content ?? m?.data?.content
    return Array.isArray(content) ? content : []
  })
}

function isTodoPart(part) {
  return (
    part?.type === 'tool' &&
    part.name === 'todowrite' &&
    part.state?.status === 'completed' &&
    Array.isArray(part.state.input?.todos)
  )
}

function todosFrom(messages) {
  const parts = partsOf(messages)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!isTodoPart(parts[i])) continue
    return parts[i].state.input.todos.filter(
      (t) => t && typeof t.content === 'string' && t.content.length > 0,
    )
  }
  return []
}

function openTodos(todos) {
  return todos.filter((t) => !DONE.has(t.status))
}

function resumeText(open) {
  return [
    `todo-enforcer: ${open.length} todo(s) are still open.`,
    ...open.map((t) => `- [${t.status}] ${t.content}`),
    '',
    'Finish each one, or mark it cancelled with todowrite. Do not stop until every todo is completed or cancelled.',
  ].join('\n')
}

// /goal keeps its state under the storage key `session:<id>`, with a `status`
// field. This key is an internal OpenCode detail: a miss just means the plugin
// runs, which is also what happens when /goal is not installed.
async function goalIsActive(ctx, sessionID) {
  try {
    const goal = await ctx.storage.get('session:' + sessionID)
    return goal?.status === 'active'
  } catch {
    return false
  }
}

export { blockedByBackground, openTodos, resumeText, todosFrom }

export default {
  id: 'vasilvestre.opencode-todo-enforcer',
  async setup(ctx) {
    const maxResumes = Number.isInteger(ctx.options?.maxResumes)
      ? ctx.options.maxResumes
      : DEFAULT_MAX_RESUMES

    // Per-session counters live in memory: a restart forgets them, and a
    // forgotten cap only means one more resume.
    const resumes = new Map()
    const lastOpen = new Map()

    await ctx.session.hook('experimental.idle', async (event) => {
      try {
        const sessionID = event?.sessionID
        if (typeof sessionID !== 'string') return
        if (blockedByBackground(event.background, sessionID)) return
        if (await goalIsActive(ctx, sessionID)) return

        const open = openTodos(todosFrom(await ctx.session.context({ sessionID })))
        if (open.length === 0) return

        const count = resumes.get(sessionID) ?? 0
        if (count >= maxResumes) return

        // Same list as the previous resume means the agent made no progress.
        // /goal pauses on "Not making progress" for the same reason.
        const signature = JSON.stringify(open.map((t) => [t.content, t.status]))
        if (lastOpen.get(sessionID) === signature) return

        lastOpen.set(sessionID, signature)
        resumes.set(sessionID, count + 1)

        await ctx.session.synthetic({
          sessionID,
          text: resumeText(open),
          metadata: { source: 'todo-enforcer' },
        })
      } catch {
        // Swallow: the idle hook runs inside the session runner.
      }
    })
  },
}
