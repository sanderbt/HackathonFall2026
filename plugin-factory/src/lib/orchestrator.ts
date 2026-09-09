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

/** What `GET /api/sessions/:id` returns, so a view that reloads can paint before its stream opens. */
export type SessionSnapshot = {
    sessionId: string;
    state: SessionState;
    pluginId: string;
    previewUrl: string | null;
    events: FactoryEvent[];
};

/** `null` for a session the orchestrator has already let go of — an answer, not a failure. */
export async function getSnapshot(
    id: string,
    signal: AbortSignal,
): Promise<SessionSnapshot | null> {
    const res = await fetch(`${base()}/api/sessions/${id}`, { signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`orchestrator returned ${res.status}`);

    const body = (await res.json()) as SessionSnapshot;
    // A body that is not a snapshot is not a session worth resuming. Answered the same way as a
    // 404 so the caller has one branch — resume this, or start something new — and a stored id
    // that leads somewhere unexpected costs a new session rather than the whole view.
    if (typeof body?.sessionId !== 'string' || !Array.isArray(body.events)) return null;
    return body;
}

/**
 * Disposes the session and everything it was holding open.
 *
 * The signal is optional because the one caller is abandoning this session on purpose: the view is
 * about to tear down its own AbortController, and a stop cancelled by that never reaches the
 * server. Harmless if it fails — creating the next session disposes the active one anyway.
 */
export async function stopSession(id: string, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${base()}/api/sessions/${id}/stop`, { method: 'POST', signal });
    if (!res.ok) throw new Error(`orchestrator returned ${res.status}`);
}

/**
 * Enough to pick a session back up after a reload.
 *
 * The id is the orchestrator's; the other two are the view's own, because nothing on the wire
 * carries them — the request text is never echoed back in the event stream, and the start of the
 * turn is only knowable to whoever sent it. Same caveat as `base()`: this is the *platform's*
 * origin storage, so the key is namespaced, and sessionStorage rather than localStorage because a
 * session outlives a reload but never the tab.
 */
export type Resumable = { id: string; request: string | null; startedAt: number | null };

const RESUME_KEY = 'plugin-factory:session';

export function remembered(): Resumable | null {
    try {
        const raw = sessionStorage.getItem(RESUME_KEY);
        const saved = raw ? (JSON.parse(raw) as Resumable) : null;
        return saved && typeof saved.id === 'string' ? saved : null;
    } catch {
        return null;
    }
}

export function remember(saved: Resumable): void {
    try {
        sessionStorage.setItem(RESUME_KEY, JSON.stringify(saved));
    } catch {
        // Storage can be denied outright. Losing resume is not worth losing the view.
    }
}

export function forget(): void {
    try {
        sessionStorage.removeItem(RESUME_KEY);
    } catch {
        // As above.
    }
}
