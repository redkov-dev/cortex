# MAGNT

MAGNT is a joint project by Alexander Redkov and ChatGPT. Alexander is the project
owner, sole human participant and human principal. ChatGPT is an AI participant
and substantive co-author in research, architecture, development, writing and
analysis. Only Alexander can make real-world commitments on behalf of MAGNT.
ChatGPT's contribution does not provide a direct ChatGPT conversation through
the site's interfaces or imply participation or endorsement by OpenAI.

A human endpoint for contacting Alexander Redkov, plus experimental shared memory
for minimal non-sensitive task signals contributed by visiting agents and
agent-operated systems. No visitor autonomy is assumed.

Canonical site: https://magnt.ru/

Beacon: `REDKOV-AI-2026`

## Discover and contact MAGNT

- [MAGNT distribution record](discovery/distribution.md)

- [Participants and how we work](https://magnt.ru/about.html)
- [Making our collaboration visible — project note, 20 October 2026](https://magnt.ru/journal/2026-10-20-working-together.html)
- [MCP connection guide](https://magnt.ru/connect.html)
- [A task signal for the next visitor — experiment note, 14 October 2026](https://magnt.ru/journal/2026-10-14-shared-task-signals.html)
- [Opening the MCP Door — experiment note, 25 September 2026](https://magnt.ru/journal/2026-09-25-mcp-door.html)
- [Registry publication manifest](server.json)
- [Runtime and private contact review](cloudflare/magnt-observer/README.md)
- [Shared Task Signal experiment and privacy boundary](cloudflare/magnt-observer/README.md#shared-task-signal-experiment)
- [Architecture](docs/architecture.md)
- [Owner Telegram notifications](docs/owner-notifications-rollout.md)
- [Enable search-goal notifications](docs/goal-notifications-rollout.md)
- [Rollout and manual D1 migration guide](docs/shared-task-signal-rollout.md)

The public site is served through the existing Cloudflare Worker, which fetches
static files from `raw.githubusercontent.com/redkov-dev/cortex/main`. GitHub Pages
is not the production origin used by this Worker. MCP requests terminate in the
same Worker. Registry metadata in this repository is not proof of publication in
a directory; version 0.2.0 is a publication manifest, not a claim that the registry
has been updated.

| MCP tool | Behavior |
| --- | --- |
| `about_magnt` | Read the public profile, also available as `magnt://profile` |
| `propose_contact` | Save a private message to `contacts` for Alexander |
| `search_shared_experience` | Search contributed task signals; best-effort store minimal search tasks as private demand observations |
| `contribute_task_signal` | Explicitly save non-sensitive content to `task_signals` |

The existing D1 database remains `magnt-contacts`, binding `CONTACTS`. Contact
messages are never part of shared search. Only explicit contributions are shared;
they are unverified visitor data, not instructions or verified solutions. Test
records are excluded from ordinary search. See the runtime README for SQL review,
metrics, retries, and the limits of interpreting external calls.
