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
| `.unimicro-mcp.json` | Optional | Live query verification. Written by the Connect button, or `npm run mcp-login`. Never by hand. |

With neither Vercel variable set, the agent and the builds run on this machine, and everything the
user sees is identical. **`VERCEL_OIDC_TOKEN` from `vercel env pull` expires after 12 hours**; use
`VERCEL_TOKEN` (plus `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`) for anything long-running.

The Unimicro session is *not* an environment variable. The sandbox runner reads this machine's CLI
session file and writes it into the sandbox, because `unimicro login` cannot work headlessly: the
loopback redirect needs a browser, device code is disabled on the current registration, and there is
no client-credentials grant. The path is whatever Go's `os.UserConfigDir` gives the CLI:

| | |
| --- | --- |
| macOS | `~/Library/Application Support/unimicro/config.json` |
| Linux | `$XDG_CONFIG_HOME/unimicro/config.json`, else `~/.config/unimicro/config.json` |
| Windows | `%AppData%\unimicro\config.json` — Roaming, and `XDG_CONFIG_HOME` is *not* consulted |

## On Windows

Everything works, but three things about the OS are load-bearing and each one fails as something
that looks unrelated:

- **`npm` and `unimicro` need `shell: true` to spawn.** Both are `.cmd` shims, and since the fix for
  CVE-2024-27980 Node refuses to run a batch file without a shell — reported as a bare
  `spawn unimicro ENOENT`, which reads as a missing install.
- **Killing a shelled child does not kill its children.** No process groups, no signals, so tearing
  a session down needs `taskkill /T` or `unimicro plugin dev` survives it, still holding the dev
  port. The next session then fails on a port in use.
- **`tar` may be GNU tar, not bsdtar.** Windows ships bsdtar in System32, but Git for Windows ships
  GNU tar and a shell that finds it first. GNU tar reads any `-f` path containing a colon as
  `host:path` and tries to reach a remote tape drive, and it strips the drive from an absolute
  member name. `tarPlugin` streams to stdout and passes a bare directory name for exactly that
  reason; do not "simplify" it back to a temp file.

## Endpoints

| | |
| --- | --- |
| `POST /api/sessions` | Start a session. Provisions in the background. |
| `GET /api/sessions/:id/events` | SSE. Honours `Last-Event-ID`, replays from a 500-event ring. |
| `POST /api/sessions/:id/messages` | `{ text }`. Returns 202; output arrives on the stream. |
| `POST /api/sessions/:id/verify` | Run the four gates alone, without an agent turn. |
| `POST /api/sessions/:id/stop` | Tear down. |

## Checking the agent's queries against the real company

The four gates prove the code compiles, passes its own mocked tests, builds and validates. None of
them can tell whether a `host.api` query is *right* — a wrong route, a wrong field name or an
unsupported filter operator comes back 200 with an empty array or the whole unfiltered collection,
and every gate passes. That is the most likely way this harness ships something confident and wrong.

Attaching Unimicro's MCP server closes exactly that gap, and nothing else: the agent reads the same
test company the plugin renders in, so it can confirm a query returns what it expects before
committing to it, and tell "wrong query" apart from "no data" when a view comes up empty.

**The user connects it from the plugin itself.** An alert offers a Connect button whenever there is
no usable token; it opens Unimicro's consent screen in a new tab, and since that browser is already
signed in to the platform, there is no login to do. The view then polls `GET /api/mcp` until the
token lands. Nothing to install, nothing to paste, no terminal.

`npm run mcp-login` does the same thing from a shell, for when the view is not up.

Activate **Unimicro Mcp** in the marketplace for the test company first, or the connection succeeds
and no tools arrive at all.

| | |
| --- | --- |
| `GET /api/mcp` | Whether a usable token exists. Never returns the token. |
| `GET /api/mcp/login` | 302 to Unimicro's broker. What the button opens. |
| `GET /api/mcp/callback` | Where the broker comes back. Exchanges the code and stores the token. |

- **The browser round-trip is the protocol, not a gap in this implementation.** The server
  advertises `authorization_code` and nothing else; token exchange is refused outright ("Only
  authorization_code is supported on the broker token endpoint"), and there is no client-credentials
  grant. Everything around the consent click — discovery, dynamic client registration, PKCE, the
  exchange — is automated.
- **The CLI session is a different credential.** The token `vercel-runner.ts` injects for the tunnel
  is refused here with a 401: separate resource, separate registration. Two doors, two keys.
- **The callback is a route on this server, not a second listener.** One port, and the redirect uri
  is matched as an exact string, so it is baked into the client registration keyed by it.
- **There is no refresh grant.** When the token expires the alert comes back, wording itself as a
  reconnect. The harness notices on the next turn rather than letting tool calls 401 mid-turn, which
  an agent reads as "no data".
- **Writes are blocked** unless `UNIMICRO_MCP_ALLOW_WRITES=1`. Blocked in the `PreToolUse` hook,
  where a deny holds even under `bypassPermissions` — same reason `unimicro plugin create` lives
  there. Enable it only to let the agent seed data so an empty view has something to render.
- **Missing is not broken.** With no token the agent runs exactly as it did before, falling back to
  the platform-api reference. Query verification is the only thing lost.

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
