import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostError } from '@unimicro/plugin-types';
import type { ViewProps } from '#lib/react-view';
import {
    base,
    createSession,
    forget,
    getSnapshot,
    remember,
    remembered,
    sendMessage,
    stopSession,
    type FactoryEvent,
    type SessionState,
} from '#lib/orchestrator';

/** A rejection from the host carries a stable `code`. Branch on that, never on the message. */
function isHostError(error: unknown): error is HostError {
    return error instanceof Error && 'code' in error;
}

/**
 * The four things a person waiting on this actually wants to know: where in the process we are,
 * that it is still moving, roughly how long it has been, and where the result is.
 *
 * Everything the agent narrates about itself — tool calls, skill reads, gate output — is progress
 * *evidence*, not progress *information*. It is collected (see `log`) and kept behind a disclosure
 * for whoever is debugging the factory, and it drives the liveness beat, but it is never the thing
 * on screen.
 */
type Phase = 'prepare' | 'build' | 'check' | 'done';

const PHASE_OF: Record<SessionState, Phase | null> = {
    created: 'prepare',
    provisioning: 'prepare',
    'dev-starting': 'prepare',
    live: null,
    working: 'build',
    verifying: 'check',
    updated: 'done',
    failed: null,
    closed: null,
};

const STEPS: { phase: Phase; name: string }[] = [
    { phase: 'prepare', name: 'Getting ready' },
    { phase: 'build', name: 'Building' },
    { phase: 'check', name: 'Checking' },
    { phase: 'done', name: 'Ready' },
];

/**
 * What to say while waiting.
 *
 * These rotate on a timer *and* advance whenever the agent reports having done something, so the
 * line moves for two independent reasons — which means a line that stops moving really has
 * stopped. They are vague on purpose: an honest "still working on it" beats a precise claim the
 * backend cannot back up.
 */
const CHATTER: Record<Phase, string[]> = {
    prepare: [
        'Waking up the workshop…',
        'Unfolding the workbench…',
        'Plugging in the cables…',
        'Borrowing a test company…',
        'Laying out the tools…',
    ],
    build: [
        'Sketching the layout…',
        'Writing the code…',
        'Fitting the pieces together…',
        'Fidgeting with the details…',
        'Naming things — the hard part…',
        'Tightening a few screws…',
        'Wiring it up to your data…',
    ],
    check: [
        'Reading it back, twice…',
        'Poking it to see if it wobbles…',
        'Trying every button…',
        'Checking the corners…',
    ],
    done: ['All done.'],
};

const SUGGESTIONS = [
    'List my ten largest unpaid customer invoices',
    'Show a table of my most recent customers',
    'Add a page that counts orders by status',
];

/** The disclosure is fixed-height and scrolls inside itself, but there is no reason to keep more. */
const MAX_LOG = 60;

/** How long a build may run before the view stops calling it normal and offers a way out. */
const SLOW_AFTER = 180;

function clock(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** As much of the agent's closing message as the ready screen has room for. */
const SUMMARY_MAX = 220;

/** The markers that only mean something at the start of a line. */
function unmark(line: string): string {
    return line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
        .trim();
}

/**
 * The wrappers that would otherwise be read out loud.
 *
 * Emphasis is matched as a pair rather than stripped character by character, so `snake_case` and
 * an arithmetic `*` survive: a lone marker is not markup, and removing it corrupts the word.
 */
function unwrap(text: string): string {
    return text
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The agent's closing message as one line of prose.
 *
 * It writes Markdown, because it writes for a terminal: a turn ends in headings, bold runs,
 * bulleted lists and the odd emoji. On the ready screen that arrived verbatim — literal `##` and
 * `**` down the middle of the stage, cut off mid-word by the line clamp — which is the one piece
 * of the agent's narration written for the reader looking like a broken template.
 *
 * Not a Markdown renderer, and deliberately not: the report is often a page long, the stage is
 * fixed-height by design, and headings and bullets rendered properly would give the payoff screen
 * a document in the middle of it. What belongs here is the sentence that says what was built. The
 * rest is not lost — the whole message goes to the log, under Technical details.
 */
function lead(text: string): string {
    // Fenced code is never the summary; it is also the one place where a `#` or a `-` at the start
    // of a line means itself, so it goes before anything else is unmarked.
    const blocks = text.replace(/```[\s\S]*?```/g, '\n\n').split(/\n\s*\n/);

    let out = '';
    for (const block of blocks) {
        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
        if (lines.length === 0) continue;
        // A heading on its own line labels what comes after it — "What was built:" — so taking it
        // as the summary would print the caption and drop the thing it captions.
        if (lines.length === 1 && /^#{1,6}\s/.test(lines[0])) continue;

        let joined = '';
        for (const line of lines) {
            const text = unmark(line);
            if (!text) continue;
            if (!joined) {
                joined = text;
                continue;
            }
            // Bullets are separate statements, and a list is written without the punctuation that
            // would separate them in a sentence. Run together with a space they read as one
            // sentence that lost its full stops.
            const item = /^(?:[-*+]|\d+[.)])\s/.test(line);
            joined += item && !/[.!?;:,]$/.test(joined) ? `; ${text}` : ` ${text}`;
        }

        const cleaned = unwrap(joined);
        if (!cleaned) continue;

        out = out ? `${out} ${cleaned}` : cleaned;
        // One paragraph is usually the whole of it. "Done!" on its own is not, and neither is the
        // "All four gates passed." a turn sometimes opens with, so a short one takes the next too.
        if (out.length >= 60) break;
    }

    if (out.length <= SUMMARY_MAX) {
        // Trailing punctuation that promises a list which is not coming. There is more, and the
        // ellipsis is where it says so.
        return out.replace(/[:;,]$/, '…');
    }

    const cut = out.slice(0, SUMMARY_MAX);
    const space = cut.lastIndexOf(' ');
    // Back to a word boundary, unless the last word is long enough that the cut is most of the
    // line — a summary of two words plus an ellipsis says less than a clipped one.
    const kept = space > SUMMARY_MAX * 0.6 ? cut.slice(0, space) : cut;
    return `${kept.replace(/[\s.,;:!?]+$/, '')}…`;
}

export default function App({ host }: ViewProps) {
    const [state, setState] = useState<SessionState>('created');
    const [request, setRequest] = useState<string | null>(null);
    const [summary, setSummary] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [log, setLog] = useState<string[]>([]);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);

    // Whether there is a plugin to look at yet. Until the first turn lands, the preview URL serves
    // the empty template the session was provisioned from — so having a URL is not the same as
    // having something worth opening, and only this says which.
    const [built, setBuilt] = useState(false);

    // Two different failures. `offline` is a stream that dropped and is retrying itself, with the
    // session still running behind it; `unreachable` is never having got a session at all, which
    // nothing recovers from on its own and so needs a button.
    const [offline, setOffline] = useState(false);
    const [unreachable, setUnreachable] = useState(false);

    // Bumped to start a session over. The effect below owns every session; this is how anything
    // outside it asks for a new one.
    const [attempt, setAttempt] = useState(0);

    // Bumped by the timer and by every sign of life from the agent. Both feed one counter, so the
    // waiting message advances on whichever happens first.
    const [beat, setBeat] = useState(0);
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const [elapsed, setElapsed] = useState(0);

    const abortRef = useRef<AbortController | null>(null);
    const composer = useRef<(HTMLElement & { value: string }) | null>(null);

    // The state the last event carried, readable synchronously. An event handler has to compare the
    // phase it is leaving with the one it is entering, and `state` is always a render behind.
    const stateRef = useRef<SessionState>('created');
    // The highest sequence number already applied. Events are not idempotent — see `onmessage`.
    const seqRef = useRef(0);
    // Held in a ref rather than in the effect's dependencies: a fresh `host` identity from the
    // platform must not be able to tear down the stream and start a second session on top of a
    // build that is still running.
    const hostRef = useRef(host);
    useEffect(() => {
        hostRef.current = host;
    }, [host]);

    const record = useCallback((text: string) => {
        setLog((prev) => [...prev, text].slice(-MAX_LOG));
    }, []);

    const note = useCallback(
        (text: string) => {
            setBeat((b) => b + 1);
            record(text);
        },
        [record],
    );

    useEffect(() => {
        const abort = new AbortController();
        abortRef.current = abort;

        let source: EventSource | null = null;
        let stopped = false;

        /**
         * One event, one place.
         *
         * Replaying a session's history and reading its live stream have to leave the view in the
         * same state, so both go through here. `live` separates out the two things that must not
         * happen twice: a toast, and a notification about a failure the user has already seen.
         */
        const apply = (event: FactoryEvent, live: boolean) => {
            switch (event.type) {
                case 'session.state': {
                    const moved = PHASE_OF[stateRef.current] !== PHASE_OF[event.state];
                    stateRef.current = event.state;
                    setState(event.state);
                    if (event.state === 'working') {
                        setSummary(null);
                        // A new turn is not the place to still be showing the last one's failure.
                        setError(null);
                    }
                    if (event.state === 'updated') setBuilt(true);
                    const line = event.detail ? `${event.state}: ${event.detail}` : event.state;
                    // A phase change restarts that phase's own list of waiting lines. Carrying the
                    // count across would open a phase on whichever line the last one left off at.
                    if (moved) {
                        setBeat(0);
                        record(line);
                    } else {
                        note(line);
                    }
                    break;
                }
                case 'agent.text':
                    // Kept, not shown while it streams: mid-turn narration is the agent thinking
                    // out loud. The last one describes what was built.
                    //
                    // Reduced to prose on the way in rather than on the way out, so there is one
                    // answer to what the screen shows. `note` gets the message as it was written,
                    // which is what makes the log the place the whole thing is still readable.
                    setSummary(lead(event.text));
                    note(event.text);
                    break;
                case 'agent.skill':
                    note(`skill: ${event.skill}`);
                    break;
                case 'agent.tool':
                    note(`${event.name} ${event.summary}`);
                    break;
                case 'verify.step':
                    note(`${event.ok ? 'ok' : 'failed'}: ${event.step}`);
                    break;
                case 'dev.event':
                    // Never on screen, but often the only thing that explains a preview which
                    // never came up — so it belongs in the log rather than dropped on the floor.
                    note(`dev: ${event.event}`);
                    break;
                case 'preview.ready':
                    setPreviewUrl(event.url);
                    note(`preview: ${event.url}`);
                    break;
                case 'error':
                    setError(event.message);
                    note(`error: ${event.message}`);
                    if (event.fatal && live) {
                        hostRef.current.notifications.error('The plugin factory failed');
                    }
                    break;
                case 'turn.done':
                    if (live) {
                        hostRef.current.notifications.success('Your plugin has been updated');
                    }
                    break;
            }
        };

        void (async () => {
            try {
                const saved = remembered();
                let id: string | null = null;

                if (saved) {
                    // A reload used to abandon the running build and start a second one. The
                    // orchestrator still holds the session and its whole history, so ask for it
                    // back before asking for a new one.
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
                        // The snapshot's own state wins over whatever the replay computed.
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
                setOffline(false);

                // Resuming asks for the gap only: the replayed history is already on screen.
                const from = seqRef.current;
                source = new EventSource(
                    `${base()}/api/sessions/${id}/events${from ? `?lastEventId=${from}` : ''}`,
                );
                source.onopen = () => setOffline(false);
                // EventSource retries on its own; this only reflects that it is currently down.
                source.onerror = () => setOffline(true);

                source.onmessage = (message) => {
                    const event = JSON.parse(message.data) as FactoryEvent;
                    // A reconnect replays from the last id the browser saw, which overlaps with
                    // what is already applied. Without this the log doubles on every reconnect and
                    // the liveness beat jumps several lines at once.
                    if (event.seq <= seqRef.current) return;
                    seqRef.current = event.seq;
                    apply(event, true);
                };
            } catch {
                if (!stopped) setUnreachable(true);
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
    }, [attempt, note, record]);

    /** Everything a new session must not inherit from the one before it. */
    const reset = useCallback(() => {
        stateRef.current = 'created';
        seqRef.current = 0;
        setState('created');
        setSessionId(null);
        setRequest(null);
        setSummary(null);
        setError(null);
        setLog([]);
        setPreviewUrl(null);
        setBuilt(false);
        setBeat(0);
        setStartedAt(null);
        setElapsed(0);
        setOffline(false);
        setUnreachable(false);
        setAttempt((a) => a + 1);
    }, []);

    const retry = useCallback(() => {
        // A session that was never reached cannot be resumed. Drop the record so the retry asks for
        // a new one instead of chasing an id the orchestrator may never have had.
        forget();
        reset();
    }, [reset]);

    const startOver = useCallback(() => {
        const id = sessionId;
        forget();
        // Fire and forget, and unsignalled on purpose: `reset` aborts the controller this view has
        // been using, which would cancel the stop before it left. Failing costs nothing either —
        // the orchestrator disposes the active session when it creates the next one.
        if (id) void stopSession(id).catch(() => {});
        reset();
    }, [reset, sessionId]);

    const phase = PHASE_OF[state];
    const working = phase === 'build' || phase === 'check';
    const starting = phase === 'prepare';
    const waiting = working || starting;
    const ready = phase === 'done';

    // The visible proof that nothing has stalled. Runs only while something is in flight, so an
    // idle view holds no timers.
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

    const chatter = CHATTER[phase ?? 'build'];
    const message = offline
        ? 'Lost contact with the workshop — reconnecting…'
        : chatter[beat % chatter.length];
    const slow = working && elapsed >= SLOW_AFTER;

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
            // Written before the request is even accepted, so a reload during the round trip still
            // finds its way back to the turn it started.
            remember({ id: sessionId, request: value, startedAt: at });

            void sendMessage(sessionId, value, signal).catch((cause: unknown) => {
                if ((cause as Error).name === 'AbortError') return; // the view is gone
                setError(String(cause));
                stateRef.current = 'failed';
                setState('failed');
            });
        },
        [sessionId, waiting],
    );

    const openPlugin = useCallback(
        async (url: string) => {
            try {
                // openExternal, not navigateTo: the platform binds tunnelId for the life of a tab,
                // and this chat is itself served through a tunnel in this one. A new tab picks up
                // the generated plugin's tunnel without disturbing ours.
                await host.navigation.openExternal(url);
            } catch (cause) {
                if (isHostError(cause) && cause.code === 'host/revoked') return; // the user left
                // This button is the only way through — the URL used to be printed beside it as a
                // fallback and is not any more — so a refusal has to be said out loud rather than
                // logged and forgotten.
                host.notifications.error('Could not open the plugin');
                host.log.error(cause, { url });
            }
        },
        [host],
    );

    const at = phase ? STEPS.findIndex((s) => s.phase === phase) : -1;

    /**
     * Where the build has got to.
     *
     * It lives inside whichever state is on screen rather than in a section of its own. Captioned
     * "Build progress" and parked between the examples and the composer, it was four blank circles
     * promising something it could not show: before a request there is no phase, so no step is
     * active, and a progress indicator with nothing marked reads as broken rather than as idle.
     * Rendered only while a build is actually running, it always has an active step — and the
     * spinner and the line above it say what it is the progress of, so the caption is no longer
     * needed for anything but the accessible name.
     */
    const progress = (
        <div className="progress" role="group" aria-label="Build progress">
            <uni-stepper horizontal class="rail">
                {STEPS.map(({ phase: step, name }, i) => (
                    <uni-step
                        key={step}
                        name={name}
                        active={(i === at && phase !== 'done') || undefined}
                        completed={(at >= 0 && (i < at || phase === 'done')) || undefined}
                    />
                ))}
            </uni-stepper>
        </div>
    );

    /**
     * The way out of this view, and the point of the whole screen once a build lands.
     *
     * Two things about it were unreadable. It rendered as soon as the tunnel came up — inert,
     * tertiary, floating between the examples and the progress rail with equal air on both sides —
     * so the one control that navigates out of here looked like a disabled fourth suggestion
     * belonging to no group. And "inert" was doing the work of two different facts: no plugin yet,
     * and a plugin being rebuilt. `built` separates them, so this now appears only when there is
     * genuinely something to open, and appears *inside* the state block that explains it: under
     * the summary of what was built on the ready screen, under the running stepper while a later
     * change is being built.
     *
     * Full-size `primary` the moment the plugin is ready — the payoff action, and the only primary
     * on the screen at that moment, because the composer's Send steps down to secondary for
     * exactly as long as this is showing. `secondary small` the rest of the time: still the same
     * shape and colour family, plainly ranked below whatever the screen is currently doing.
     */
    const open = built && previewUrl && (
        <div className={ready ? 'open open--ready' : 'open'}>
            <uni-button
                variant={ready ? 'primary' : 'secondary'}
                small={!ready || undefined}
                onClick={() => openPlugin(previewUrl)}
            >
                Open your plugin
            </uni-button>
        </div>
    );

    return (
        <section>
            {/* Not `uni-page-header`. That component is page chrome — a 5.25rem sticky bar with its
                own side padding and a rule underneath — and this view is a single centred column
                that never scrolls, so the bar sat inside the column misaligned with it, ruled off
                from it, and printed the plugin's name at nearly the size of the question below it.
                Two headings, one of them furniture. The name is a nameplate here; the question is
                the headline, and the h1 is styled to say so. */}
            <h1 className="title">Plugin Factory</h1>

            {unreachable && (
                <uni-alert type="critical" header="Cannot reach the plugin factory">
                    Nothing is answering at {base()}. Start the orchestrator, then try again.
                    <uni-button slot="actions" variant="secondary" small onClick={retry}>
                        Try again
                    </uni-button>
                </uni-alert>
            )}

            {offline && !unreachable && (
                <uni-alert type="warning" header="Lost contact with the plugin factory">
                    Reconnecting. Anything already running carries on without us.
                </uni-alert>
            )}

            {error && (
                <uni-alert type="critical" header="That did not work">
                    {error}
                    <uni-button slot="actions" variant="secondary" small onClick={startOver}>
                        Start over
                    </uni-button>
                </uni-alert>
            )}

            <div className="stage">
                <div className="panel">
                    {working ? (
                        <div className="wait">
                            <span className="pulse" aria-hidden="true" />
                            {/* The region is what has to stay put; only the line inside it is
                                replaced. Keying the line remounts it, and remounting is what
                                restarts the animation — a CSS animation does not re-run when an
                                element's text changes underneath it. */}
                            <div className="live" aria-live="polite">
                                <p className="message" key={message}>
                                    {message}
                                </p>
                            </div>
                            {request && <p className="echo">“{request}”</p>}
                            {progress}
                            <p className="reassure">
                                <span>
                                    {slow
                                        ? 'Longer than usual. It may still land, or you can start again.'
                                        : 'Still going — this usually takes a minute or two.'}
                                </span>
                                {/* Deliberately outside the live region: a value that changes once
                                    a second inside one makes a screen reader re-read the whole
                                    block once a second. */}
                                <span aria-hidden="true">{clock(elapsed)}</span>
                            </p>
                            {slow && (
                                <uni-button variant="tertiary" small onClick={startOver}>
                                    Stop and start over
                                </uni-button>
                            )}
                            {open}
                        </div>
                    ) : ready ? (
                        <div className="wait">
                            <span className="tick" aria-hidden="true">
                                ✓
                            </span>
                            <div className="live" aria-live="polite">
                                <p className="message">Your plugin is ready</p>
                            </div>
                            {summary && <p className="summary">{summary}</p>}
                            {open}
                            <p className="reassure">Ask for another change below whenever you like.</p>
                        </div>
                    ) : (
                        <div className="intro">
                            {/* One question, asked once. The "in plain language" half of what used
                                to be two near-identical lines now lives in the composer's
                                placeholder, where it is read at the moment it is acted on. */}
                            <h2>What should your plugin do?</h2>
                            <p className="label">For example</p>
                            <div className="suggestions">
                                {SUGGESTIONS.map((s) => (
                                    <uni-button
                                        key={s}
                                        variant="secondary"
                                        small
                                        disabled={waiting || !sessionId || undefined}
                                        onClick={() => submit(s)}
                                    >
                                        {s}
                                    </uni-button>
                                ))}
                            </div>
                            {starting && (
                                <p className="reassure" aria-live="polite">
                                    <span className="dots" aria-hidden="true" />
                                    {message} Ready for your first request in a moment.
                                </p>
                            )}
                            {/* Nothing on a first visit: `built` is false, so the way out of the
                                view is simply absent until there is somewhere for it to go. This
                                is the intro a change came back to after failing — the plugin from
                                before is still standing, and this is how to go and look at it. */}
                            {open}
                        </div>
                    )}
                </div>
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
                {/* The placeholder is not an example. A fifth one here, absent from the curated
                    three above, made the whole set look generated rather than chosen; this says
                    how to write instead, which is the half of the old intro copy worth keeping. */}
                <uni-textarea
                    ref={composer}
                    label="Describe the plugin you want"
                    label-hidden
                    resize="auto"
                    readonly={waiting || undefined}
                    placeholder={
                        waiting
                            ? 'Working on it…'
                            : 'Describe a page or a change, in plain language…'
                    }
                />
                {/* Under the field, centred, rather than wedged against its bottom-right corner.
                    Beside a box this wide a default-width button reads as an afterthought stuck to
                    the edge, and `resize="auto"` means the box it was aligned to changes height as
                    you type. Its own row cannot be knocked out of alignment by either. */}
                <div className="composer__send">
                    {/* Secondary for exactly one state. Two filled blue buttons were on screen at
                        the moment a build landed — this one and "Open your plugin" — both reading
                        as the primary action while doing unrelated things. Iterating is the more
                        frequent action and keeps the primary everywhere else; on the ready screen
                        the payoff outranks it for one beat, and stepping this down is what says
                        so. The label goes with it: "Build it" is what a first-time reader is
                        actually doing, and "Send" only makes sense once there is something to
                        send a change to. */}
                    <uni-button
                        variant={ready ? 'secondary' : 'primary'}
                        loading={working || undefined}
                        disabled={waiting || undefined}
                        onClick={() => submit()}
                    >
                        {built ? 'Send' : 'Build it'}
                    </uni-button>
                </div>
            </div>

            {/* `uni-details`, not `uni-expansion-panel`. The panel prints its own toggle label
                beside the header, and that label defaults to Norwegian — "Åpne" on an otherwise
                English screen — so the only way to keep it in one language was to pass
                `open-label`/`close-label` and keep them in step with the rest of the copy. Details
                has no second label to leak, and no border: the panel was the one boxed thing on a
                flat screen, which made the debug log look like a debug panel someone forgot to
                take out. Its `max-height` goes on the <pre> instead — see the stylesheet. */}
            {log.length > 0 && (
                <uni-details label="Technical details" class="log">
                    <pre>{log.join('\n')}</pre>
                </uni-details>
            )}
        </section>
    );
}
