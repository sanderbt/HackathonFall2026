import { query } from '@anthropic-ai/claude-agent-sdk';
import type { EventBus } from './bus.ts';
import type { PluginTarget } from './runner.ts';

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

Verify after every change, in this exact order:
  1. npm run check
  2. npm test
  3. npm run build
  4. unimicro plugin validate --json
Step 4 reports entryFileMissing unless step 3 has run, so never reorder them.

Do NOT wait on \`unimicro plugin dev\` output to decide whether a build succeeded. This project uses
proxy dev mode, where build verdicts never arrive. The four commands above are the only truth.

If the same error survives three fix attempts, stop and explain the problem in plain language to the
business user who asked for this. Do not thrash.
`.trim();

/**
 * Run one user turn.
 *
 * Returns the SDK session id so the next turn can resume with the conversation intact.
 */
export async function runAgentTurn(
    target: PluginTarget,
    prompt: string,
    bus: EventBus,
    resume: string | undefined,
): Promise<{ sessionId: string | undefined; usd?: number; turns?: number }> {
    let sessionId = resume;

    const stream = query({
        prompt,
        options: {
            cwd: target.dir,
            // Required. Without it the five platform skill files silently do not load, and the
            // agent writes confident code against an API it has invented.
            settingSources: ['project'],
            skills: 'all',
            permissionMode: 'bypassPermissions',
            maxTurns: 80,
            // A thrashing loop with five skills in context gets expensive fast.
            maxBudgetUsd: 5,
            resume,
            systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT },
            hooks: {
                // Hooks run before every other permission step, and a hook deny applies even under
                // bypassPermissions. That makes this the only place these rules can actually hold.
                PreToolUse: [
                    {
                        hooks: [
                            async (input) => {
                                // The SDK types tool_input as unknown, since its shape depends on
                                // which tool fired. Narrow it here rather than at every use.
                                const hook = input as {
                                    tool_name?: string;
                                    tool_input?: Record<string, unknown>;
                                };
                                const name = hook.tool_name;
                                const args = hook.tool_input ?? {};

                                if (name === 'Bash' && FORBIDDEN.test(String(args.command ?? ''))) {
                                    return {
                                        decision: 'block' as const,
                                        reason:
                                            'That command is the harness\'s, not yours. The plugin id is already ' +
                                            'reserved and permanent — creating another burns a global name forever — ' +
                                            'and the dev tunnel is already running. Edit the source and verify.',
                                    };
                                }

                                if (
                                    (name === 'Write' || name === 'Edit') &&
                                    PROTECTED.test(String(args.file_path ?? ''))
                                ) {
                                    return {
                                        decision: 'block' as const,
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

    let usd: number | undefined;
    let turns: number | undefined;

    for await (const message of stream as AsyncIterable<Record<string, unknown>>) {
        const type = message.type;

        if (type === 'system' && message.subtype === 'init') {
            sessionId = String(message.session_id ?? sessionId ?? '');

            // Fail loudly rather than let the agent produce plausible-looking nonsense against a
            // hallucinated API. The skills are the single biggest lever on output quality.
            const skills = (message.skills as string[] | undefined) ?? [];
            const missing = ['cli', 'plugin-dev', 'host-api', 'platform-api', 'design-system'].filter(
                (s) => !skills.includes(s),
            );
            if (missing.length) {
                bus.emit({
                    type: 'error',
                    message: `Platform skills did not load: ${missing.join(', ')}. Output would be guesswork.`,
                    fatal: true,
                });
            }
            continue;
        }

        if (type === 'assistant') {
            const content = (message.message as { content?: unknown[] } | undefined)?.content ?? [];
            for (const block of content as Array<Record<string, unknown>>) {
                if (block.type === 'text' && String(block.text).trim()) {
                    bus.emit({ type: 'agent.text', text: String(block.text) });
                } else if (block.type === 'tool_use') {
                    const toolName = String(block.name);
                    if (toolName === 'Skill') {
                        const skill = String(
                            (block.input as { name?: unknown } | undefined)?.name ?? '',
                        );
                        bus.emit({ type: 'agent.skill', skill });
                    } else {
                        bus.emit({ type: 'agent.tool', name: toolName, summary: summarise(block) });
                    }
                }
            }
            continue;
        }

        if (type === 'result') {
            usd = message.total_cost_usd as number | undefined;
            turns = message.num_turns as number | undefined;
        }
    }

    return { sessionId, usd, turns };
}

/** A one-line label for a tool call — enough for a collapsed row in the transcript. */
function summarise(block: Record<string, unknown>): string {
    const input = (block.input ?? {}) as Record<string, unknown>;
    const first =
        input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.description ?? '';
    return String(first).slice(0, 160);
}
