import type { EventBus } from './bus.ts';

/** What `run.mjs` returns from a completed turn. */
export type TurnResult = { sessionId: string | undefined; usd?: number; turns?: number };

/**
 * Feeds one NDJSON line from `run.mjs` into the bus, wherever that process ran.
 *
 * Both LocalRunner (a plain child process) and VercelRunner (the same script, inside a sandbox)
 * produce identical lines, so this is the one place that turns them into `FactoryEvent`s — kept
 * out of both runners so the parsing can't drift between them.
 */
export function feedAgentLine(bus: EventBus, line: string, onDone: (result: TurnResult) => void): void {
    if (!line.trim()) return;

    let event: Record<string, unknown>;
    try {
        event = JSON.parse(line);
    } catch {
        return; // A stray non-JSON line (a stack trace fragment, say) is not ours to understand.
    }

    switch (event.type) {
        case 'agent.text':
            bus.emit({ type: 'agent.text', text: String(event.text) });
            return;
        case 'agent.tool':
            bus.emit({ type: 'agent.tool', name: String(event.name), summary: String(event.summary) });
            return;
        case 'agent.skill':
            bus.emit({ type: 'agent.skill', skill: String(event.skill) });
            return;
        case 'error':
            bus.emit({
                type: 'error',
                message: String(event.message),
                fatal: Boolean(event.fatal),
            });
            return;
        case 'turn.done':
            onDone({
                sessionId: event.sessionId as string | undefined,
                usd: event.usd as number | undefined,
                turns: event.turns as number | undefined,
            });
            return;
    }
}
