import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HostError } from '@unimicro/plugin-types';
import type { ViewProps } from '#lib/react-view';
import {
    base,
    createSession,
    sendMessage,
    type FactoryEvent,
    type SessionState,
} from '#lib/orchestrator';

/** A rejection from the host carries a stable `code`. Branch on that, never on the message. */
function isHostError(error: unknown): error is HostError {
    return error instanceof Error && 'code' in error;
}

/** One row in the transcript. Deliberately flat — this is a prototype, not a chat framework. */
type Item =
    | { kind: 'user'; text: string }
    | { kind: 'assistant'; text: string }
    | { kind: 'note'; text: string }
    | { kind: 'gate'; step: string; ok: boolean }
    | { kind: 'error'; text: string }
    | { kind: 'ready'; url: string };

/** A runaway loop must not put tens of thousands of nodes in the platform's page. */
const MAX_ITEMS = 300;

const STATUS: Record<SessionState, string> = {
    created: 'Starting up…',
    provisioning: 'Setting up your workspace…',
    'dev-starting': 'Connecting to your test company…',
    live: 'Ready — tell me what you want to build.',
    working: 'Writing the code…',
    verifying: 'Checking it compiles, passes tests and validates…',
    updated: 'Done. Refresh your plugin tab to see it.',
    failed: 'That did not work.',
    closed: 'Session closed.',
};

const SUGGESTIONS = [
    'List my ten largest unpaid customer invoices',
    'Show a table of my most recent customers',
    'Add a page that counts orders by status',
];

export default function App({ host }: ViewProps) {
    const [items, setItems] = useState<Item[]>([]);
    const [state, setState] = useState<SessionState>('created');
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [offline, setOffline] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);

    const abortRef = useRef<AbortController | null>(null);
    const composer = useRef<(HTMLElement & { value: string }) | null>(null);
    const scroller = useRef<HTMLDivElement | null>(null);

    const push = useCallback((item: Item) => {
        setItems((prev) => [...prev, item].slice(-MAX_ITEMS));
    }, []);

    useEffect(() => {
        const abort = new AbortController();
        abortRef.current = abort;

        let source: EventSource | null = null;
        let stopped = false;

        void (async () => {
            try {
                const id = await createSession(abort.signal);
                if (stopped) return;
                setSessionId(id);
                setOffline(false);

                source = new EventSource(`${base()}/api/sessions/${id}/events`);
                source.onopen = () => setOffline(false);
                // EventSource retries on its own; this only reflects that it is currently down.
                source.onerror = () => setOffline(true);

                source.onmessage = (message) => {
                    const event = JSON.parse(message.data) as FactoryEvent;

                    switch (event.type) {
                        case 'session.state':
                            setState(event.state);
                            break;
                        case 'agent.text':
                            push({ kind: 'assistant', text: event.text });
                            break;
                        case 'agent.skill':
                            push({ kind: 'note', text: `Reading the ${event.skill} documentation` });
                            break;
                        case 'agent.tool':
                            push({ kind: 'note', text: `${event.name} ${event.summary}` });
                            break;
                        case 'verify.step':
                            push({ kind: 'gate', step: event.step, ok: event.ok });
                            break;
                        case 'preview.ready':
                            setPreviewUrl(event.url);
                            push({ kind: 'ready', url: event.url });
                            break;
                        case 'error':
                            push({ kind: 'error', text: event.message });
                            if (event.fatal) host.notifications.error('The plugin factory failed');
                            break;
                        case 'turn.done':
                            host.notifications.success('Your plugin has been updated');
                            break;
                    }
                };
            } catch (error) {
                if (!stopped) setOffline(true);
            }
        })();

        return () => {
            // Nothing else does either of these. The platform revokes `host` and releases the
            // subscriptions it granted; it cannot see a socket this view opened, so an EventSource
            // left behind keeps reconnecting inside the platform's page for the life of the tab.
            stopped = true;
            abort.abort();
            source?.close();
        };
    }, [host, push]);

    // Follow the tail only when the reader is already at the bottom, so reading history is not
    // yanked away mid-stream.
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
    }, [items]);

    const busy = state === 'working' || state === 'verifying';

    const submit = useCallback(
        (text?: string) => {
            const value = (text ?? composer.current?.value ?? '').trim();
            if (!value || !sessionId || busy) return;
            if (composer.current && !text) composer.current.value = '';

            push({ kind: 'user', text: value });
            void sendMessage(sessionId, value, abortRef.current!.signal).catch((error: unknown) => {
                if ((error as Error).name === 'AbortError') return; // the view is gone
                push({ kind: 'error', text: String(error) });
            });
        },
        [sessionId, busy, push],
    );

    const openPlugin = useCallback(
        async (url: string) => {
            try {
                // openExternal, not navigateTo: the platform binds tunnelId for the life of a tab,
                // and this chat is itself served through a tunnel in this one. A new tab picks up
                // the generated plugin's tunnel without disturbing ours.
                await host.navigation.openExternal(url);
            } catch (error) {
                if (isHostError(error) && error.code === 'host/revoked') return;
                host.log.error(error, { url });
            }
        },
        [host],
    );

    return (
        <section>
            <uni-page-header heading="Plugin Factory" />

            {offline && (
                <uni-alert type="critical" header="Cannot reach the plugin factory">
                    Nothing is answering at {base()}. Start the orchestrator and reload.
                </uni-alert>
            )}

            <div className="transcript" ref={scroller} role="log">
                {items.length === 0 && !offline && (
                    <div className="empty">
                        <p>Describe the functionality you want, in plain language.</p>
                        <div className="suggestions">
                            {SUGGESTIONS.map((s) => (
                                <uni-button key={s} variant="secondary" small onClick={() => submit(s)}>
                                    {s}
                                </uni-button>
                            ))}
                        </div>
                    </div>
                )}

                {items.map((item, i) => {
                    switch (item.kind) {
                        case 'user':
                            return (
                                <div key={i} className="row user">
                                    {item.text}
                                </div>
                            );
                        case 'assistant':
                            return (
                                <div key={i} className="row assistant">
                                    {item.text}
                                </div>
                            );
                        case 'note':
                            return (
                                <div key={i} className="row note">
                                    {item.text}
                                </div>
                            );
                        case 'gate':
                            return (
                                <div key={i} className="row note">
                                    {item.ok ? '✓' : '✗'} {item.step}
                                </div>
                            );
                        case 'error':
                            return (
                                <uni-alert key={i} type="critical">
                                    {item.text}
                                </uni-alert>
                            );
                        case 'ready':
                            return (
                                <uni-card key={i} class="ready">
                                    <p>Your plugin is running in this company.</p>
                                    <uni-button onClick={() => openPlugin(item.url)}>
                                        Open your plugin
                                    </uni-button>
                                    <p className="url">{item.url}</p>
                                </uni-card>
                            );
                    }
                })}
            </div>

            <p className="status" aria-live="polite">
                {busy && <span className="dots" aria-hidden="true" />}
                {STATUS[state]}
            </p>

            <div
                className="composer"
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        submit();
                    }
                }}
            >
                <uni-textarea
                    ref={composer}
                    label="Describe the plugin you want"
                    label-hidden
                    resize="auto"
                    placeholder="A page that lists overdue invoices…"
                />
                <uni-button loading={busy} onClick={() => submit()}>
                    Send
                </uni-button>
            </div>

            {previewUrl && !items.some((i) => i.kind === 'ready') && (
                <uni-button variant="secondary" small onClick={() => openPlugin(previewUrl)}>
                    Open your plugin
                </uni-button>
            )}
        </section>
    );
}
