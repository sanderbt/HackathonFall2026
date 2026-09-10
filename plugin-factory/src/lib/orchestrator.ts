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
 * The models the orchestrator's allowlist accepts, mirrored from `server.ts`'s `ALLOWED_MODELS`.
 * A value outside this set is dropped server-side and falls back to the harness's own default, so
 * keeping the two lists in sync is only a UX nicety, never a correctness requirement.
 */
export type ModelId = 'claude-haiku-4-5-20251001' | 'claude-sonnet-5' | 'claude-opus-5';

export const MODELS: Array<{ id: ModelId; label: string }> = [
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-opus-5', label: 'Opus 5' },
];

export const DEFAULT_MODEL: ModelId = 'claude-haiku-4-5-20251001';

const MODEL_KEY = 'plugin-factory:model';

export function isModelId(value: string): value is ModelId {
    return MODELS.some((m) => m.id === value);
}

/** The user's remembered model choice, same `localStorage` caveats as `base()`. */
export function getModel(): ModelId {
    try {
        const saved = localStorage.getItem(MODEL_KEY);
        return saved && isModelId(saved) ? saved : DEFAULT_MODEL;
    } catch {
        return DEFAULT_MODEL;
    }
}

export function saveModel(id: ModelId): void {
    try {
        localStorage.setItem(MODEL_KEY, id);
    } catch {
        // Storage can be denied outright. Losing the preference is not worth losing the view.
    }
}

/**
 * How much thinking Claude puts into a turn, mirrored from `server.ts`'s `ALLOWED_EFFORTS`. Same
 * fallback rule as a model: a value outside this set is dropped server-side, and the harness's own
 * default (`'high'`) applies.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORTS: Array<{ id: Effort; label: string }> = [
    { id: 'low', label: 'Lav' },
    { id: 'medium', label: 'Middels' },
    { id: 'high', label: 'Høy' },
    { id: 'xhigh', label: 'Ekstra høy' },
    { id: 'max', label: 'Maks' },
];

export const DEFAULT_EFFORT: Effort = 'high';

const EFFORT_KEY = 'plugin-factory:effort';

export function isEffort(value: string): value is Effort {
    return EFFORTS.some((e) => e.id === value);
}

/** The user's remembered effort choice, same `localStorage` caveats as `base()`. */
export function getEffort(): Effort {
    try {
        const saved = localStorage.getItem(EFFORT_KEY);
        return saved && isEffort(saved) ? saved : DEFAULT_EFFORT;
    } catch {
        return DEFAULT_EFFORT;
    }
}

export function saveEffort(id: Effort): void {
    try {
        localStorage.setItem(EFFORT_KEY, id);
    } catch {
        // Storage can be denied outright. Losing the preference is not worth losing the view.
    }
}

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
    model: ModelId,
    effort: Effort,
    signal: AbortSignal,
): Promise<void> {
    const res = await fetch(`${base()}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, model, effort }),
        signal,
    });
    if (!res.ok) throw new Error(`orchestrator returned ${res.status}`);
}

/**
 * Whether the factory can read this company's data, mirrored from the orchestrator's `McpStatus`.
 *
 * Never carries the token — only whether there is a usable one. `expired` is kept apart from
 * `connected` because they deserve different words on screen: one has never been connected, the
 * other was and needs a click to carry on.
 */
export type McpStatus = {
    connected: boolean;
    url: string;
    expiresAt: number | null;
    expired: boolean;
};

export async function getMcpStatus(signal: AbortSignal): Promise<McpStatus> {
    const res = await fetch(`${base()}/api/mcp`, { signal });
    if (!res.ok) throw new Error(`orchestrator returned ${res.status}`);
    return (await res.json()) as McpStatus;
}

/**
 * Where to send a browser tab to connect the company's data.
 *
 * A plain url the view opens directly, rather than a fetch that returns one: the orchestrator
 * answers it with a 302 to Unimicro's broker, so the tab goes straight there, and the browser
 * doing the opening is the one already signed in to Unimicro. Fetching a url first and opening it
 * second is the shape popup blockers exist to catch.
 */
export function mcpLoginUrl(): string {
    return `${base()}/api/mcp/login`;
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
