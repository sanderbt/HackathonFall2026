# Plugin Factory orchestrator

Drives one chat session: resets the demo plugin, brings its dev tunnel up in the test company, runs
the coding agent, and gates the result on four checks — streaming the whole thing to the chat view
over SSE.

```sh
npm install
npm start          # http://127.0.0.1:8787
```

## Credentials

| Variable | Needed | What for |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | **Now** | The coding agent. A logged-in `claude` CLI works instead. |
| `VERCEL_TOKEN` *or* `VERCEL_OIDC_TOKEN` | Only for the sandbox | Creating Vercel Sandboxes. |
| `FACTORY_REPO_URL` | Only for the sandbox | Git URL the sandbox clones the plugin from. |
| `GITHUB_TOKEN` | Only if that repo is private | Used as the password with username `x-access-token`. |

With neither Vercel variable set, the agent and the builds run on this machine, and everything the
user sees is identical. **`VERCEL_OIDC_TOKEN` from `vercel env pull` expires after 12 hours**; use
`VERCEL_TOKEN` (plus `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`) for anything long-running.

The Unimicro session is *not* an environment variable. The sandbox runner reads this machine's CLI
session file — `~/Library/Application Support/unimicro/config.json` on macOS,
`~/.config/unimicro/config.json` on Linux — and writes it into the sandbox, because `unimicro login`
cannot work headlessly: the loopback redirect needs a browser, device code is disabled on the
current registration, and there is no client-credentials grant.

## Endpoints

| | |
| --- | --- |
| `POST /api/sessions` | Start a session. Provisions in the background. |
| `GET /api/sessions/:id/events` | SSE. Honours `Last-Event-ID`, replays from a 500-event ring. |
| `POST /api/sessions/:id/messages` | `{ text }`. Returns 202; output arrives on the stream. |
| `POST /api/sessions/:id/verify` | Run the four gates alone, without an agent turn. |
| `POST /api/sessions/:id/stop` | Tear down. |

## Things that are load-bearing

- **Bound to `127.0.0.1`.** There is no authentication and none is possible worth the name: a plugin
  view's `getContext()` is unsigned plain JSON with no token, and the platform gives a view no way
  to prove who it is to a third party. Loopback-only is the one mitigation with teeth.
- **The plugin is never created, only edited.** Plugin ids are global, permanent and digit-free, and
  `create` reserves one *before* validating its other arguments — so even a failed create burns a
  name forever. A `PreToolUse` hook blocks the agent from running `create` or `publish` at all;
  hooks deny even under `bypassPermissions`, which is why the rule lives there and not in
  `disallowedTools`.
- **Build before validate.** With no `dist/`, `validate` reports `entryFileMissing` and nothing else.
- **Never wait on `unimicro plugin dev` for a build verdict.** These plugins use proxy dev mode,
  where `dev.started` reports `"verdicts": false` and `build.succeeded` / `build.failed` never
  arrive. Waiting on one hangs forever and looks like a network fault. The gates are the only truth.
- **One session at a time.** The demo plugin is a single working tree on a single dev port, and if
  the Unimicro issuer rotates refresh tokens, two sandboxes sharing one session would fight.
