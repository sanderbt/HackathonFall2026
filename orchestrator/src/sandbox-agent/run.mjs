#!/usr/bin/env node
/**
 * One agent turn, as a standalone process.
 *
 * This file is what makes the two Runners genuinely interchangeable: LocalRunner spawns it as a
 * plain child process against the plugin on disk; VercelRunner uploads it and runs the identical
 * script inside the sandbox. Neither the orchestrator's server nor the chat view can tell which
 * one ran — they only ever see the NDJSON this script prints.
 *
 * Usage: node run.mjs --prompt-file <path> --cwd <plugin-dir> [--resume <sdk-session-id>]
 *   [--model <model-id>] [--effort <low|medium|high|xhigh|max>]
 *
 * The prompt arrives as a FILE, never as an argv string — user prose through a shell argument is a
 * quoting accident waiting to happen, and this runs the same way locally and in a sandbox either
 * way.
 *
 * Output: one JSON object per stdout line. Every line has a `type`; see the orchestrator's
 * `FactoryEventBody` for the shapes this mirrors. The final line is always `turn.done`, carrying
 * the SDK session id so the next turn can resume the conversation.
 */

import { readFile } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
        args[argv[i].replace(/^--/, '')] = argv[i + 1];
    }
    return args;
}

function emit(event) {
    process.stdout.write(JSON.stringify(event) + '\n');
}

/**
 * Commands the harness owns, not the agent.
 *
 * `create` and `publish` are the dangerous ones: a plugin id is global, permanent and digit-free,
 * and `create` reserves it *before* validating anything else, so even a failed create burns a name
 * forever. An agent asked for an invoice page will happily reach for `invoice-tracker`.
 */
const FORBIDDEN =
    /\bunimicro\s+plugin\s+(create|publish|app|application|skills|move-lane)\b|\bunimicro\s+(login|logout|company|onboard)\b/;

/** Files whose contents are contracts with the CLI, documented in their own comments. */
const PROTECTED = /(^|\/)(vite\.config\.ts|tsconfig\.json|unimicro\.config\.json|manifest\.json)$/;

/**
 * The Unimicro MCP server, when the harness passed a token for it.
 *
 * Attached under the name `unimicro`, so its tools arrive as `mcp__unimicro__*`. Absent when no
 * token was passed, and that is a supported way to run — the agent falls back to reading the
 * platform-api reference, exactly as it did before this existed. See `../unimicro-mcp.ts` for why
 * the token has to be handed in rather than fetched.
 */
const MCP_URL = process.env.UNIMICRO_MCP_URL;
const MCP_TOKEN = process.env.UNIMICRO_MCP_TOKEN;
const MCP_ENABLED = Boolean(MCP_URL && MCP_TOKEN);

/**
 * Writes go through the platform for real, even in a test company, so they are off by default.
 *
 * Matched on the tool NAME rather than declared per tool: the tool list depends on the server's
 * version and on the caller's rights — Unimicro's own guide says to ask what tools exist rather
 * than assume — so there is no fixed set of names to enumerate here.
 */
const MCP_WRITE_VERBS = new Set([
    'create', 'new', 'add', 'insert', 'update', 'edit', 'change', 'set', 'write',
    'patch', 'put', 'post', 'delete', 'remove', 'cancel', 'void',
    'approve', 'reject', 'send', 'pay', 'book', 'register', 'import', 'upload',
]);

/**
 * Whether an MCP tool name looks like a write.
 *
 * Matched on whole name segments rather than as a substring, which a first attempt got wrong in a
 * way worth recording: `add` appears inside `get_customer_address` and `book` inside
 * `get_bookkeeping_summary`, so a substring check quietly blocks reads. Splitting on non-alphanumerics
 * and comparing whole words is the difference between a heuristic and a trap.
 *
 * It is still a heuristic. It errs toward blocking — a read caught here costs the agent a fallback
 * to the reference docs, while a write missed here posts to somebody's books.
 */
function isMcpWrite(name) {
    const prefix = 'mcp__unimicro__';
    if (!String(name).startsWith(prefix)) return false;

    return String(name)
        .slice(prefix.length)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((segment) => MCP_WRITE_VERBS.has(segment));
}

const MCP_ALLOW_WRITES = process.env.UNIMICRO_MCP_ALLOW_WRITES === '1';

const SYSTEM_PROMPT = `
You are editing a live Unimicro plugin. A dev tunnel is already running and the user is watching the
result render in their real test company, so every change you make is visible to them within seconds.

BEFORE writing any view code, read the \`plugin-dev\` and \`host-api\` skills.
BEFORE fetching or writing any business data, read the \`platform-api\` skill.
BEFORE using any UI component, read the \`design-system\` skill.
These are installed in .claude/skills and they are authoritative over your priors. The platform's
entity routes are frequently not the entity's name — look them up, never guess.

Scope: exactly one view, already scaffolded at src/views/main/. It is React:
  - src/views/main/index.ts is four lines and stays that way. Do not put JSX in it.
  - src/views/main/App.tsx is the component. It receives { host } and nothing else.
  - src/views/main/view.css is imported with ?inline.
Do not add views. Do not change the plugin id. Do not edit vite.config.ts, tsconfig.json,
unimicro.config.json or manifest.json — the harness owns those. Do not run any
\`unimicro plugin create/publish\` command; the plugin already exists and the tunnel is already up.

You are not done when the code looks right. You are done when these four commands all exit clean, in
this exact order, run by YOU with the Bash tool, most recently in this same turn:
  1. npm run check
  2. npm test
  3. npm run build
  4. unimicro plugin validate --json
Step 4 reports entryFileMissing unless step 3 has just run, so never reorder them, and never skip
straight to validate on the assumption that an earlier build still counts.

Do NOT wait on \`unimicro plugin dev\` output to decide whether a build succeeded. This project uses
proxy dev mode, where build verdicts never arrive. The four commands above are the only truth — not
your read of the diff, not "that should work now".

If a gate fails: read the actual error text, fix the root cause, then re-run **all four from the
top**, not just the one that failed — a fix for step 2 can break step 1. You have up to 80 turns and
a real budget in this one conversation; use them. Loop this yourself rather than reporting back after
a single attempt. Only stop and explain the problem in plain language to the business user if the
identical failure survives three of your own fix-and-rerun cycles within this turn.

You do not get partial credit for "close" — a plugin that fails npm test is not a finished plugin,
it is a bug report the user did not ask to receive.

## The four gates cannot see whether your query is right

npm test runs against a mock of host.api that you yourself wrote, npm run check only knows types,
and validate only checks the manifest. None of them can tell you whether host.api.get(entity, query)
is actually asking the platform for the right thing. A query with a wrong entity route, a wrong field
name, a missing expand, or a filter operator the platform does not support does NOT error — it comes
back 200 with either an empty array or, worse, the whole unfiltered collection. All four gates pass
regardless. This is the most likely way you ship something that "works" and is wrong.

So: every field name, expand path and route you use in a host.api call must come from literally
re-reading the matching section of the platform-api entities reference in this same turn — not from
memory, not by pattern-matching a similar-sounding entity you used earlier. If a page you just wrote
renders zero rows, your default hypothesis is a wrong query, never "there is no data" — re-open the
reference doc and check every field and expand path character by character before you consider any
other explanation.

Never tell the user their data is showing correctly unless you have genuinely confirmed it. You
cannot — your tests are mocked and you have no browser here. So report only what the four gates
actually proved (types, mocked tests, build, manifest), never "viser reelle data fra systemet ditt" or
equivalent. If you have any doubt the query shape is exactly right, say so plainly and name the one
thing you were unable to verify from here — do not paper over it with confident language.

## How to write the last thing you say

The person on the other end is not in a terminal. They are looking at one line of text under a
"Your plugin is ready" heading, in a UI with no Markdown renderer in it — so a heading, a bold run,
a bullet or an emoji arrives on their screen as the literal characters ## ** - and a mystery.

So write the final message of the turn as plain prose. No Markdown of any kind. No headings, no
bold, no lists, no emoji, no file paths, no command names, no gate names. Two or three sentences at
most, and put the useful one first: what they can now do with their plugin, in their own words.
"Kundeoversikten viser navn, kundenummer og antall fakturaer per kunde." Not "Perfekt! Alle fire
gatene har passert." — that a build passed is not news to someone who was watching it happen, and
spending their first sentence on it pushes the answer off the screen.

Write it in the language the user wrote to you in, matching them turn by turn.

This applies to the last message specifically, but everything you say mid-turn is streamed to the
same place, so it is the safer default throughout. Your working notes are not lost either way —
tool calls and narration are all kept, and the person can open them if they want them.
`.trim();

/**
 * Appended only when the MCP server is actually attached.
 *
 * Kept separate rather than folded into SYSTEM_PROMPT with an "if you have it" hedge: telling an
 * agent about tools it does not have is how you get invented tool calls and a turn spent recovering
 * from them.
 */
const MCP_PROMPT = `
## You can check your queries against the real company

The Unimicro MCP server is attached. Its tools are named mcp__unimicro__* and they reach the same
test company the plugin renders in, as the same user. List them before you plan around them — which
tools exist depends on the server version and on what your user is allowed to do.

Use it to settle the one question the four gates cannot answer. The platform-api reference tells you
which fields and routes exist; MCP tells you what this company actually holds. So before you settle
on a host.api call, read the equivalent data through MCP and look at the field names and values that
come back — then write the query against what you just saw, not against what you expected to see.

This also resolves the zero-rows ambiguity. If a page you wrote renders nothing, ask MCP whether the
records exist at all. That turns "wrong query" versus "no data" from a guess into an answer, and
your default hypothesis stays "wrong query" until MCP says the company is genuinely empty.

${
    MCP_ALLOW_WRITES
        ? `Writes are enabled for this session. Use them only to give the view something to render — a
customer, an invoice — and say plainly in your final message what you created, because these are
real records in the user's test company and they will stay there.`
        : `MCP is read-only here: the harness blocks every write tool. If you find yourself wanting one —
usually to seed data so an empty view has something to show — do not look for a way around it. Say
what you would have created and why, and let the person decide.`
}

What this does NOT license: MCP confirms the query, not the rendering. You still have no browser and
your tests are still mocked. So "the query returns 14 rows in your test company" is something you
may now say. "The view is showing your data correctly" is still something you cannot know.
`.trim();

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const prompt = await readFile(args['prompt-file'], 'utf8');

    const stream = query({
        prompt,
        options: {
            cwd: args.cwd,
            // Required. Without it the five platform skill files silently do not load, and the
            // agent writes confident code against an API it has invented.
            settingSources: ['project'],
            skills: 'all',
            // Haiku is the default over Sonnet's own: this harness is tool-calling + skill-reading,
            // not creative writing, and Haiku is a fraction of the cost per token for that shape of
            // work. The chat view lets the user override it per turn via --model.
            model: args.model || 'claude-haiku-4-5-20251001',
            // Left unset, the SDK's own default ('high') applies. --effort lets the chat view trade
            // thinking depth for speed per turn, same as --model.
            effort: args.effort || undefined,
            permissionMode: 'bypassPermissions',
            maxTurns: 80,
            // A thrashing loop with five skills in context gets expensive fast.
            maxBudgetUsd: 1,
            resume: args.resume || undefined,
            systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                append: MCP_ENABLED ? `${SYSTEM_PROMPT}\n\n${MCP_PROMPT}` : SYSTEM_PROMPT,
            },
            ...(MCP_ENABLED
                ? {
                      mcpServers: {
                          unimicro: {
                              type: 'http',
                              url: MCP_URL,
                              headers: { Authorization: `Bearer ${MCP_TOKEN}` },
                              // Without this the tools sit behind tool search and the agent has to
                              // discover them; with it they are in the turn-1 prompt, which is
                              // where they need to be for the query-checking rule above to fire on
                              // the first query rather than the second.
                              alwaysLoad: true,
                          },
                      },
                  }
                : {}),
            // `settingSources: ['project']` is what loads the five platform skills, and it would
            // also load any `.mcp.json` sitting in the plugin directory. The plugin tree is written
            // by an agent, so what MCP servers this process talks to is the harness's decision, not
            // something the working tree gets to add to.
            strictMcpConfig: true,
            hooks: {
                // Hooks run before every other permission step, and a hook deny applies even under
                // bypassPermissions. That makes this the only place these rules can actually hold.
                PreToolUse: [
                    {
                        hooks: [
                            async (input) => {
                                const name = input.tool_name;
                                const toolArgs = input.tool_input ?? {};

                                if (name === 'Bash' && FORBIDDEN.test(String(toolArgs.command ?? ''))) {
                                    return {
                                        decision: 'block',
                                        reason:
                                            "That command is the harness's, not yours. The plugin id is already " +
                                            'reserved and permanent — creating another burns a global name forever — ' +
                                            'and the dev tunnel is already running. Edit the source and verify.',
                                    };
                                }

                                if (!MCP_ALLOW_WRITES && isMcpWrite(name)) {
                                    return {
                                        decision: 'block',
                                        reason:
                                            'MCP is read-only in this session. That tool would write to the ' +
                                            "user's real test company, which is not yours to decide. Read what " +
                                            'you need, and if the view has nothing to show, say so and say what ' +
                                            'data would make it show something.',
                                    };
                                }

                                if (
                                    (name === 'Write' || name === 'Edit') &&
                                    PROTECTED.test(String(toolArgs.file_path ?? ''))
                                ) {
                                    return {
                                        decision: 'block',
                                        reason:
                                            'That file encodes a contract with `unimicro plugin dev` and is owned by ' +
                                            'the harness. Everything you need to change lives in src/views/main/.',
                                    };
                                }

                                return {};
                            },
                        ],
                    },
                ],
            },
        },
    });

    let sessionId = args.resume;
    let usd;
    let turns;

    for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
            sessionId = message.session_id ?? sessionId;

            // Fail loudly rather than let the agent produce plausible-looking nonsense against a
            // hallucinated API. The skills are the single biggest lever on output quality.
            const skills = message.skills ?? [];
            const missing = ['cli', 'plugin-dev', 'host-api', 'platform-api', 'design-system'].filter(
                (s) => !skills.includes(s),
            );
            if (missing.length) {
                emit({
                    type: 'error',
                    message: `Platform skills did not load: ${missing.join(', ')}. Output would be guesswork.`,
                    fatal: true,
                });
            }

            // Say it here rather than let it surface as tool calls failing mid-turn, which the
            // agent reads as "no data" and reports as an empty result. Not fatal, unlike the skills
            // check: without MCP the agent still has the reference docs and can still finish the
            // plugin — it just cannot verify its queries, and the person deserves to know which of
            // those two turns they got.
            if (MCP_ENABLED) {
                // `mcp_servers` on the wire, whatever the SDK's own type declaration says — it
                // types this as `mcpServers` and the camelCase read comes back undefined, which
                // would make every single turn report a connection failure. Both are read so a
                // later SDK that honours its own types does not break this back the other way.
                const servers = message.mcp_servers ?? message.mcpServers ?? [];
                const server = servers.find((s) => s.name === 'unimicro');
                if (server?.status !== 'connected') {
                    emit({
                        type: 'error',
                        message:
                            `Unimicro MCP did not connect (${server?.status ?? 'absent'}). Run ` +
                            '`npm run mcp-login` — the token has most likely expired. This turn will ' +
                            'run without live query verification.',
                        fatal: false,
                    });
                }
            }
            continue;
        }

        if (message.type === 'assistant') {
            for (const block of message.message?.content ?? []) {
                if (block.type === 'text' && block.text?.trim()) {
                    emit({ type: 'agent.text', text: block.text });
                } else if (block.type === 'tool_use') {
                    if (block.name === 'Skill') {
                        emit({ type: 'agent.skill', skill: block.input?.name ?? '' });
                    } else {
                        emit({ type: 'agent.tool', name: block.name, summary: summarise(block) });
                    }
                }
            }
            continue;
        }

        if (message.type === 'result') {
            usd = message.total_cost_usd;
            turns = message.num_turns;
        }
    }

    emit({ type: 'turn.done', sessionId, usd, turns });
}

/** A one-line label for a tool call — enough for a collapsed row in the transcript. */
function summarise(block) {
    const input = block.input ?? {};
    const known =
        input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.description;
    if (known !== undefined) return String(known).slice(0, 160);

    // MCP tools have their own argument names — `entity`, `companyKey`, whatever this server's
    // version calls them — and none of the above match. Rather than render a blank row for the
    // most interesting calls in the transcript, take the first scalar the tool was given.
    const scalar = Object.values(input).find(
        (value) => typeof value === 'string' || typeof value === 'number',
    );
    return String(scalar ?? '').slice(0, 160);
}

main().catch((error) => {
    emit({ type: 'error', message: String(error?.stack ?? error), fatal: true });
    process.exitCode = 1;
});
