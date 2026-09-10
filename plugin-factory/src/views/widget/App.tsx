import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostError } from '@unimicro/plugin-types';
import type { ViewProps } from '#lib/react-view';
import { CHATTER, clock, PHASE_OF, SLOW_AFTER, STEPS } from '#lib/progress';
import { lead } from '#lib/summary';
import {
    base,
    createSession,
    EFFORTS,
    forget,
    getEffort,
    getModel,
    getSnapshot,
    MODELS,
    remember,
    remembered,
    saveEffort,
    saveModel,
    sendMessage,
    stopSession,
    type Effort,
    type FactoryEvent,
    type ModelId,
    type SessionState,
} from '#lib/orchestrator';

/** A rejection from the host carries a stable `code`. Branch on that, never on the message. */
function isHostError(error: unknown): error is HostError {
    return error instanceof Error && 'code' in error;
}

/**
 * Shorter than the full page's, and deliberately: they are read in a dashboard tile a third of the
 * width, where a sentence-long prompt wraps to three ragged lines.
 */
const SUGGESTIONS = ['Vis mine største ubetalte fakturaer', 'Tell ordre etter status'];

export default function App({ host }: ViewProps) {
    const [state, setState] = useState<SessionState>('created');
    const [request, setRequest] = useState<string | null>(null);
    const [summary, setSummary] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [built, setBuilt] = useState(false);
    const [unreachable, setUnreachable] = useState(false);
    const [attempt, setAttempt] = useState(0);

    // Per-turn, like the full page: read at click time by `submit`, so switching either never
    // requires starting over.
    const [model, setModel] = useState<ModelId>(() => getModel());
    const [effort, setEffort] = useState<Effort>(() => getEffort());

    // Bumped by the timer and by every sign of life from the agent. Both feed one counter, so the
    // waiting message advances on whichever happens first — and a line that stops moving really
    // has stopped.
    const [beat, setBeat] = useState(0);
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const [elapsed, setElapsed] = useState(0);

    const composer = useRef<(HTMLElement & { value: string }) | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const stateRef = useRef<SessionState>('created');
    const seqRef = useRef(0);
    const hostRef = useRef(host);
    useEffect(() => {
        hostRef.current = host;
    }, [host]);

    /**
     * What this tile can hold.
     *
     * A dashboard widget is handed a fraction of the page's room, and there is no media query for
     * "how big is the box the platform gave this view" — so it is measured. Each rung stands a few
     * more parts down, decoration first: the pulse and the tick say "working" and "done" beside a
     * line that says so in words, and the echo repeats the request the reader just typed. The step
     * rail is the last to go, being the only one carrying a fact of its own — and it also needs
     * real width, since four steps on one line is what it is for.
     */
    const stageRef = useRef<HTMLDivElement | null>(null);
    const [room, setRoom] = useState<'full' | 'tight' | 'minimal'>('full');
    const [narrow, setNarrow] = useState(false);
    useEffect(() => {
        const el = stageRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(([entry]) => {
            const { height, width } = entry.contentRect;
            setRoom(height < 150 ? 'minimal' : height < 230 ? 'tight' : 'full');
            setNarrow(width < 380);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const note = useCallback(() => setBeat((b) => b + 1), []);

    useEffect(() => {
        const abort = new AbortController();
        abortRef.current = abort;

        let source: EventSource | null = null;
        let stopped = false;

        const apply = (event: FactoryEvent, live: boolean) => {
            switch (event.type) {
                case 'session.state': {
                    const moved = PHASE_OF[stateRef.current] !== PHASE_OF[event.state];
                    stateRef.current = event.state;
                    setState(event.state);
                    if (event.state === 'working') {
                        setSummary(null);
                        setError(null);
                    }
                    if (event.state === 'updated') setBuilt(true);
                    // A phase change restarts that phase's own list of waiting lines. Carrying the
                    // count across would open a phase on whichever line the last one left off at.
                    if (moved) setBeat(0);
                    else note();
                    break;
                }
                case 'agent.text':
                    // Mid-turn narration is the agent thinking out loud; the last one describes
                    // what was built, which is the only part written for the reader.
                    setSummary(lead(event.text));
                    note();
                    break;
                case 'agent.skill':
                case 'agent.tool':
                case 'verify.step':
                case 'dev.event':
                    // Never on screen here — this tile has no log — but they are what proves the
                    // build is alive, so they still move the waiting line.
                    note();
                    break;
                case 'preview.ready':
                    setPreviewUrl(event.url);
                    break;
                case 'error':
                    setError(event.message);
                    if (event.fatal && live) hostRef.current.notifications.error('Plugin-fabrikken feilet');
                    break;
                case 'turn.done':
                    if (live) hostRef.current.notifications.success('Pluginen din er oppdatert');
                    break;
            }
        };

        void (async () => {
            try {
                const saved = remembered();
                let id: string | null = null;

                if (saved) {
                    const snapshot = await getSnapshot(saved.id, abort.signal);
                    if (stopped) return;

                    if (snapshot) {
                        id = snapshot.sessionId;
                        setPreviewUrl(snapshot.previewUrl);
                        // Neither of these is on the wire, so they can only come back from here.
                        setRequest(saved.request);
                        setStartedAt(saved.startedAt);
                        for (const event of snapshot.events) apply(event, false);
                        seqRef.current = snapshot.events.at(-1)?.seq ?? 0;
                        stateRef.current = snapshot.state;
                        setState(snapshot.state);
                    } else {
                        forget();
                    }
                }

                if (!id) {
                    id = await createSession(abort.signal);
                    if (stopped) return;
                    remember({ id, request: null, startedAt: null });
                }

                setSessionId(id);
                setUnreachable(false);

                const from = seqRef.current;
                source = new EventSource(
                    `${base()}/api/sessions/${id}/events${from ? `?lastEventId=${from}` : ''}`,
                );
                source.onmessage = (message) => {
                    const event = JSON.parse(message.data) as FactoryEvent;
                    if (event.seq <= seqRef.current) return;
                    seqRef.current = event.seq;
                    apply(event, true);
                };
            } catch {
                if (!stopped) setUnreachable(true);
            }
        })();

        return () => {
            stopped = true;
            abort.abort();
            source?.close();
        };
    }, [attempt, note]);

    const reset = useCallback(() => {
        stateRef.current = 'created';
        seqRef.current = 0;
        setState('created');
        setSessionId(null);
        setRequest(null);
        setSummary(null);
        setError(null);
        setPreviewUrl(null);
        setBuilt(false);
        setUnreachable(false);
        setBeat(0);
        setStartedAt(null);
        setElapsed(0);
        setAttempt((a) => a + 1);
    }, []);

    /** Cancels whatever is running and starts a fresh session. Also what "try again" falls back to. */
    const restart = useCallback(() => {
        const id = sessionId;
        forget();
        if (id) void stopSession(id).catch(() => {});
        reset();
    }, [sessionId, reset]);

    const phase = PHASE_OF[state];
    const working = phase === 'build' || phase === 'check';
    const starting = phase === 'prepare';
    const waiting = working || starting;
    const ready = phase === 'done';

    // The visible proof that nothing has stalled. Runs only while something is in flight, so an
    // idle tile holds no timers.
    useEffect(() => {
        if (!waiting) return;
        const id = setInterval(() => setBeat((b) => b + 1), 3200);
        return () => clearInterval(id);
    }, [waiting]);

    useEffect(() => {
        if (!working) {
            setStartedAt(null);
            setElapsed(0);
            return;
        }
        // A resumed build brings its own start time with it; only a fresh one starts the clock.
        setStartedAt((at) => at ?? Date.now());
    }, [working]);

    useEffect(() => {
        if (!working || startedAt === null) return;
        const tick = () => setElapsed(Math.round((Date.now() - startedAt) / 1000));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [working, startedAt]);

    const submit = useCallback(
        (text?: string) => {
            const value = (text ?? composer.current?.value ?? '').trim();
            const signal = abortRef.current?.signal;
            if (!value || !sessionId || !signal || waiting) return;
            if (composer.current && !text) composer.current.value = '';

            const at = Date.now();
            setRequest(value);
            setSummary(null);
            setError(null);
            setBeat(0);
            setStartedAt(at);
            // Optimistic: the state event that confirms it is a round trip away, and a composer
            // that clears into an unchanged screen reads as a dropped request.
            stateRef.current = 'working';
            setState('working');
            remember({ id: sessionId, request: value, startedAt: at });

            void sendMessage(sessionId, value, model, effort, signal).catch((cause: unknown) => {
                if ((cause as Error).name === 'AbortError') return;
                setError(String(cause));
                stateRef.current = 'failed';
                setState('failed');
            });
        },
        [sessionId, waiting, model, effort],
    );

    const selectModel = useCallback((id: ModelId) => {
        setModel(id);
        saveModel(id);
    }, []);

    const selectEffort = useCallback((id: Effort) => {
        setEffort(id);
        saveEffort(id);
    }, []);

    const openPlugin = useCallback(async () => {
        if (!previewUrl) return;
        try {
            // openExternal, not navigateTo: the platform binds tunnelId for the life of a tab, and
            // this dashboard is itself served through a tunnel in this one.
            await host.navigation.openExternal(previewUrl);
        } catch (cause) {
            if (isHostError(cause) && cause.code === 'host/revoked') return;
            host.notifications.error('Kunne ikke åpne pluginen');
            host.log.error(cause, { view: 'widget' });
        }
    }, [host, previewUrl]);

    const chatter = CHATTER[phase ?? 'build'];
    const message = chatter[beat % chatter.length];
    const slow = working && elapsed >= SLOW_AFTER;
    const at = phase ? STEPS.findIndex((s) => s.phase === phase) : -1;

    /** Where the build has got to. Only ever rendered while there is a phase to mark. */
    const rail = (
        <uni-stepper horizontal class="rail" aria-label="Byggefremdrift">
            {STEPS.map(({ phase: step, name }, i) => (
                <uni-step
                    key={step}
                    name={name}
                    active={(i === at && phase !== 'done') || undefined}
                    completed={(at >= 0 && (i < at || phase === 'done')) || undefined}
                />
            ))}
        </uni-stepper>
    );

    /**
     * The way out of the tile, and the point of the whole screen once a build lands. Full-size
     * `primary` on the ready screen; `secondary small` while a later change is building, where it
     * is plainly ranked below the build in progress but still reachable.
     */
    const open = built && previewUrl && (
        <div className={ready ? 'open open--ready' : 'open'}>
            <uni-button variant={ready ? 'primary' : 'secondary'} small={!ready || undefined} onClick={openPlugin}>
                Åpne pluginen din
            </uni-button>
        </div>
    );

    return (
        <section>
            <h2 className="title">Plugin-fabrikken</h2>

            {unreachable && (
                <uni-alert type="critical">
                    Kan ikke nå plugin-fabrikken.
                    <uni-button slot="actions" variant="secondary" small onClick={restart}>
                        Prøv igjen
                    </uni-button>
                </uni-alert>
            )}

            {error && (
                <uni-alert type="critical">
                    {error}
                    <uni-button slot="actions" variant="secondary" small onClick={restart}>
                        Start på nytt
                    </uni-button>
                </uni-alert>
            )}

            <div className="stage" ref={stageRef} data-room={room}>
                {/* `working`, not `waiting`: starting up is not a build, so it keeps the question and
                    the prompts on screen with a quiet note underneath, rather than replacing them
                    with a spinner and a step rail for something nobody has asked for yet. */}
                {working ? (
                    <div className="panel">
                        <span className="pulse" aria-hidden="true" />
                        {/* The region is what has to stay put; only the line inside it is replaced.
                            Keying the line remounts it, and remounting is what restarts the fade —
                            a CSS animation does not re-run when an element's text changes under it. */}
                        <div className="live" aria-live="polite">
                            <p className="message" key={message}>
                                {message}
                            </p>
                        </div>
                        {request && <p className="echo">“{request}”</p>}
                        {!narrow && room !== 'minimal' && rail}
                        <p className="reassure">
                            <span>
                                {slow ? 'Tar lengre tid enn vanlig.' : 'Dette tar vanligvis et minutt eller to.'}
                            </span>
                            {/* Outside the live region on purpose: a value that changes once a
                                second inside one makes a screen reader re-read the whole block. */}
                            <span aria-hidden="true">{clock(elapsed)}</span>
                        </p>
                        {open}
                    </div>
                ) : ready ? (
                    <div className="panel panel--done">
                        <span className="tick" aria-hidden="true">
                            ✓
                        </span>
                        <div className="live" aria-live="polite">
                            <p className="message">Pluginen din er klar</p>
                        </div>
                        {summary && <p className="summary">{summary}</p>}
                        {open}
                    </div>
                ) : (
                    <div className="panel panel--intro">
                        <p className="message">Hva skal pluginen din gjøre?</p>
                        {room === 'full' && <p className="label">For eksempel</p>}
                        {room !== 'minimal' && (
                            <div className="suggestions">
                                {SUGGESTIONS.map((s) => (
                                    <uni-button
                                        key={s}
                                        variant="secondary"
                                        small
                                        disabled={!sessionId || undefined}
                                        onClick={() => submit(s)}
                                    >
                                        {s}
                                    </uni-button>
                                ))}
                            </div>
                        )}
                        {starting && (
                            <p className="reassure" aria-live="polite">
                                <span className="dots" aria-hidden="true" />
                                {message} Klar for din første forespørsel om et øyeblikk.
                            </p>
                        )}
                        {open}
                    </div>
                )}
            </div>

            <div className="settings">
                <uni-dropdown-menu placement="top-start">
                    <uni-button slot="toggle" variant="tertiary" xs caret disabled={waiting || undefined}>
                        {MODELS.find((m) => m.id === model)?.label ?? model}
                    </uni-button>
                    <uni-menu onuni-select={(event: any) => selectModel(event.detail.dataset.model as ModelId)}>
                        {MODELS.map((m) => (
                            <uni-menu-item key={m.id} data-model={m.id} selected={m.id === model || undefined}>
                                {m.label}
                            </uni-menu-item>
                        ))}
                    </uni-menu>
                </uni-dropdown-menu>
                <uni-dropdown-menu placement="top-start">
                    <uni-button slot="toggle" variant="tertiary" xs caret disabled={waiting || undefined}>
                        {EFFORTS.find((e) => e.id === effort)?.label ?? effort}
                    </uni-button>
                    <uni-menu onuni-select={(event: any) => selectEffort(event.detail.dataset.effort as Effort)}>
                        {EFFORTS.map((e) => (
                            <uni-menu-item key={e.id} data-effort={e.id} selected={e.id === effort || undefined}>
                                {e.label}
                            </uni-menu-item>
                        ))}
                    </uni-menu>
                </uni-dropdown-menu>
            </div>

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
                    label="Beskriv pluginen du vil ha"
                    label-hidden
                    resize="auto"
                    readonly={waiting || !sessionId || undefined}
                    placeholder={waiting ? 'Arbeider med det…' : 'Beskriv en side eller en endring…'}
                />
                {working ? (
                    <uni-button variant="destructive" small onClick={restart}>
                        Stopp
                    </uni-button>
                ) : (
                    <uni-button
                        variant={ready ? 'secondary' : 'primary'}
                        small
                        disabled={waiting || !sessionId || undefined}
                        onClick={() => submit()}
                    >
                        {built ? 'Send' : 'Bygg'}
                    </uni-button>
                )}
            </div>
        </section>
    );
}
