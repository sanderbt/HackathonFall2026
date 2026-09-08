/**
 * The wire contract between the orchestrator and the chat view.
 *
 * This file is the whole interface. The view is built against it and can be developed against a
 * canned script of these events with no backend running at all, which is what keeps the UI
 * demoable while the sandbox path is still being wired up.
 */

/** Where a session is in its lifecycle. The view renders a status line from this. */
export type SessionState =
    | 'created'
    | 'provisioning'
    | 'dev-starting'
    | 'live' // the plugin renders, but is still the untouched scaffold
    | 'working' // the agent is editing
    | 'verifying'
    | 'updated' // a verified change is live
    | 'failed'
    | 'closed';

export type VerifyStep = 'check' | 'test' | 'build' | 'validate';

/**
 * Every event carries a monotonic `seq`, sent as the SSE `id:`. A reconnecting EventSource sends
 * `Last-Event-ID`, and the server replays from the ring buffer — so a dropped connection costs the
 * user nothing.
 */
export type FactoryEventBody =
    | { type: 'session.state'; state: SessionState; detail?: string }
    /** A line of assistant prose. Appended to the open assistant turn. */
    | { type: 'agent.text'; text: string }
    /** The agent used a tool. `summary` is already short enough to render as a label. */
    | { type: 'agent.tool'; name: string; summary: string }
    /** The agent opened a platform skill. "Reading the platform-api skill" is a good demo beat. */
    | { type: 'agent.skill'; skill: string }
    | { type: 'verify.step'; step: VerifyStep; ok: boolean; output?: string }
    /** Raw passthrough of `unimicro plugin dev --json` NDJSON, for the build-output panel. */
    | { type: 'dev.event'; event: string; data: unknown }
    /** The tunnel is up. The view shows the "Open your plugin" button from here on. */
    | { type: 'preview.ready'; url: string; tunnelId: string; companyKey: string }
    | { type: 'error'; message: string; fatal: boolean }
    | { type: 'turn.done'; usd?: number; turns?: number };

/**
 * The same event with its sequence number attached.
 *
 * Kept as an intersection over a separate union rather than `Omit<FactoryEvent, 'seq'>`: Omit does
 * not distribute over a union, so that form silently collapses every variant into one and every
 * `type`-specific field stops type-checking.
 */
export type FactoryEvent = FactoryEventBody & { seq: number };

/** What `GET /api/sessions/:id` returns, so a fresh view can paint before the stream opens. */
export type SessionSnapshot = {
    sessionId: string;
    state: SessionState;
    pluginId: string;
    previewUrl: string | null;
    events: FactoryEvent[];
};
