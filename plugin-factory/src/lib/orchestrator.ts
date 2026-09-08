/**
 * The orchestrator's wire contract, mirrored on the client.
 *
 * Kept as its own small file rather than imported across packages: a plugin's build ships views,
 * and reaching into a sibling workspace would drag the orchestrator's dependency graph into the
 * artifact. This is a handful of types — a copy is cheaper than the coupling.
 */

export type SessionState =
    | 'created'
    | 'provisioning'
    | 'dev-starting'
    | 'live'
    | 'working'
    | 'verifying'
    | 'updated'
    | 'failed'
    | 'closed';

export type VerifyStep = 'check' | 'test' | 'build' | 'validate';

export type FactoryEvent = { seq: number } & (
    | { type: 'session.state'; state: SessionState; detail?: string }
    | { type: 'agent.text'; text: string }
    | { type: 'agent.tool'; name: string; summary: string }
    | { type: 'agent.skill'; skill: string }
    | { type: 'verify.step'; step: VerifyStep; ok: boolean; output?: string }
    | { type: 'dev.event'; event: string; data: unknown }
    | { type: 'preview.ready'; url: string; tunnelId: string; companyKey: string }
    | { type: 'error'; message: string; fatal: boolean }
    | { type: 'turn.done'; usd?: number; turns?: number }
);

const FALLBACK = 'http://127.0.0.1:8787';

/**
 * Where the orchestrator lives.
 *
 * Overridable at runtime because during a hackathon the backend moves, and repointing a running
 * view beats a rebuild. Two honest caveats: localStorage in a native view is the *platform's*
 * origin storage, so the key is namespaced and this is a prototype affordance only; and the env
 * fallback is baked in at build time, so it is configuration, never a secret.
 */
export function base(): string {
    try {
        return localStorage.getItem('plugin-factory:orchestrator') || FALLBACK;
    } catch {
        return FALLBACK;
    }
}

export async function createSession(signal: AbortSignal): Promise<string> {
    const res = await fetch(`${base()}/api/sessions`, { method: 'POST', signal });
    if (!res.ok) throw new Error(`orchestrator returned ${res.status}`);
    return (await res.json()).sessionId as string;
}

export async function sendMessage(
    sessionId: string,
    text: string,
    signal: AbortSignal,
): Promise<void> {
    const res = await fetch(`${base()}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
    });
    if (!res.ok) throw new Error(`orchestrator returned ${res.status}`);
}
