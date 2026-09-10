import { useCallback, useEffect, useRef, useState } from "react";
import type { HostError } from "@unimicro/plugin-types";
import type { ViewProps } from "#lib/react-view";
import {
  base,
  createSession,
  EFFORTS,
  forget,
  getEffort,
  getMcpStatus,
  getModel,
  getSnapshot,
  mcpLoginUrl,
  MODELS,
  remember,
  remembered,
  saveEffort,
  saveModel,
  sendMessage,
  stopSession,
  type Effort,
  type FactoryEvent,
  type McpStatus,
  type ModelId,
  type SessionState,
} from "#lib/orchestrator";

/** How often, and for how long, the view checks whether a sign-in in another tab has landed. */
const CONNECT_POLL_MS = 1500;
const CONNECT_WINDOW_MS = 3 * 60 * 1000;

/** A rejection from the host carries a stable `code`. Branch on that, never on the message. */
function isHostError(error: unknown): error is HostError {
  return error instanceof Error && "code" in error;
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
type Phase = "prepare" | "build" | "check" | "done";

const PHASE_OF: Record<SessionState, Phase | null> = {
  created: "prepare",
  provisioning: "prepare",
  "dev-starting": "prepare",
  live: null,
  working: "build",
  verifying: "check",
  updated: "done",
  failed: null,
  closed: null,
};

const STEPS: { phase: Phase; name: string }[] = [
  { phase: "prepare", name: "Gjør klar" },
  { phase: "build", name: "Bygger" },
  { phase: "check", name: "Sjekker" },
  { phase: "done", name: "Klar" },
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
    "Vekker verkstedet…",
    "Slår ut arbeidsbenken…",
    "Kobler til kablene…",
    "Låner et testfirma…",
    "Legger fram verktøyet…",
  ],
  build: [
    "Skisserer oppsettet…",
    "Skriver koden…",
    "Setter delene sammen…",
    "Finpusser detaljene…",
    "Navngir ting — den vanskelige delen…",
    "Strammer noen skruer…",
    "Kobler den til dataene dine…",
  ],
  check: [
    "Leser gjennom, to ganger…",
    "Ser om den vipper…",
    "Prøver hver knapp…",
    "Sjekker hjørnene…",
  ],
  done: ["Helt ferdig."],
};

const SUGGESTIONS = [
  "List mine ti største ubetalte kundefakturaer",
  "Vis en tabell over mine nyeste kunder",
  "Legg til en side som teller ordre etter status",
];

/** The log scrolls inside its own panel, but there is no reason to keep more than this. */
const MAX_LOG = 60;

/** How long a build may run before the view stops calling it normal and offers a way out. */
const SLOW_AFTER = 180;

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** As much of the agent's closing message as the ready screen has room for. */
const SUMMARY_MAX = 220;

/** The markers that only mean something at the start of a line. */
function unmark(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
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
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
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
 * rest is not lost — the whole message goes to the log, under "Tekniske detaljer".
 */
function lead(text: string): string {
  // Fenced code is never the summary; it is also the one place where a `#` or a `-` at the start
  // of a line means itself, so it goes before anything else is unmarked.
  const blocks = text.replace(/```[\s\S]*?```/g, "\n\n").split(/\n\s*\n/);

  let out = "";
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    // A heading on its own line labels what comes after it — "What was built:" — so taking it
    // as the summary would print the caption and drop the thing it captions.
    if (lines.length === 1 && /^#{1,6}\s/.test(lines[0])) continue;

    let joined = "";
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
    return out.replace(/[:;,]$/, "…");
  }

  const cut = out.slice(0, SUMMARY_MAX);
  const space = cut.lastIndexOf(" ");
  // Back to a word boundary, unless the last word is long enough that the cut is most of the
  // line — a summary of two words plus an ellipsis says less than a clipped one.
  const kept = space > SUMMARY_MAX * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s.,;:!?]+$/, "")}…`;
}

export default function App({ host }: ViewProps) {
  const [state, setState] = useState<SessionState>("created");
  const [request, setRequest] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // The log opens into the stage rather than into the composer. Anything with a height of its own
  // down there pushes the field off the bottom of the frame, because the composer is the last row
  // in a column that never scrolls — see `.stage` in the stylesheet.
  const [logOpen, setLogOpen] = useState(false);

  // How much of the waiting screen fits. A measurement, not a media query: this view is mounted in
  // the platform's own frame, which is not the viewport, so nothing in CSS can ask about its size.
  const [room, setRoom] = useState<"full" | "tight" | "minimal">("full");

  // Remembered across reloads, same as the orchestrator override — but per turn, not per
  // session: it rides along on the next `sendMessage` rather than fixing the session at
  // creation, so switching models never requires starting over.
  const [model, setModel] = useState<ModelId>(() => getModel());
  const [effort, setEffort] = useState<Effort>(() => getEffort());

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

  // Whether the factory can read this company's own data, which is what lets the agent check a
  // query instead of trusting the reference docs. The credential belongs to the orchestrator, not
  // to this view — so all the view can do is ask, and send the user to a consent screen.
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [connecting, setConnecting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const composer = useRef<(HTMLElement & { value: string }) | null>(null);
  const pollRef = useRef<number | null>(null);
  const logEl = useRef<HTMLPreElement | null>(null);
  const stageEl = useRef<HTMLDivElement | null>(null);

  // The state the last event carried, readable synchronously. An event handler has to compare the
  // phase it is leaving with the one it is entering, and `state` is always a render behind.
  const stateRef = useRef<SessionState>("created");
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

  // Follows the tail rather than leaving a new line to land below the fold: the box is as tall as
  // the stage lets it be and the log only ever grows, so without this a reader who opened it would
  // watch it fill up while the newest line stayed out of sight. Also on open, which is when the
  // whole backlog appears at once.
  useEffect(() => {
    const el = logEl.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, logOpen]);

  /**
   * What the stage can hold.
   *
   * It is the one row of the column with no height of its own — it is whatever the title, the
   * alerts and the composer leave behind — so on a short frame, or with an alert up, it can end up
   * with less room than the waiting screen needs. Rather than let the screen clip, each rung here
   * stands a few more of its parts down; the stylesheet says which, and `examples` below thins the
   * intro the same way.
   *
   * Measured off the stage rather than asked of a media query, because the two are not the same
   * question: an alert appearing takes 6rem out of this box without changing the frame at all.
   */
  useEffect(() => {
    const el = stageEl.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    // Measured against what each rung of the ladder below actually needs — see the stylesheet for
    // what each one drops.
    const observer = new ResizeObserver(([entry]) => {
      const height = entry.contentRect.height;
      setRoom(height < 136 ? "minimal" : height < 232 ? "tight" : "full");
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
        case "session.state": {
          const moved = PHASE_OF[stateRef.current] !== PHASE_OF[event.state];
          stateRef.current = event.state;
          setState(event.state);
          if (event.state === "working") {
            setSummary(null);
            // A new turn is not the place to still be showing the last one's failure.
            setError(null);
          }
          if (event.state === "updated") setBuilt(true);
          const line = event.detail
            ? `${event.state}: ${event.detail}`
            : event.state;
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
        case "agent.text":
          // Kept, not shown while it streams: mid-turn narration is the agent thinking
          // out loud. The last one describes what was built.
          //
          // Reduced to prose on the way in rather than on the way out, so there is one
          // answer to what the screen shows. `note` gets the message as it was written,
          // which is what makes the log the place the whole thing is still readable.
          setSummary(lead(event.text));
          note(event.text);
          break;
        case "agent.skill":
          note(`skill: ${event.skill}`);
          break;
        case "agent.tool":
          note(`${event.name} ${event.summary}`);
          break;
        case "verify.step":
          note(`${event.ok ? "ok" : "failed"}: ${event.step}`);
          break;
        case "dev.event":
          // Never on screen, but often the only thing that explains a preview which
          // never came up — so it belongs in the log rather than dropped on the floor.
          note(`dev: ${event.event}`);
          break;
        case "preview.ready":
          setPreviewUrl(event.url);
          note(`preview: ${event.url}`);
          break;
        case "error":
          setError(event.message);
          note(`error: ${event.message}`);
          if (event.fatal && live) {
            hostRef.current.notifications.error("Plugin-fabrikken feilet");
          }
          break;
        case "turn.done":
          if (live) {
            hostRef.current.notifications.success(
              "Pluginen din er oppdatert",
            );
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
          `${base()}/api/sessions/${id}/events${from ? `?lastEventId=${from}` : ""}`,
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
    stateRef.current = "created";
    seqRef.current = 0;
    setState("created");
    setSessionId(null);
    setRequest(null);
    setSummary(null);
    setError(null);
    setLog([]);
    // Nothing left to read, and an empty box where the waiting screen should be is worse than none.
    setLogOpen(false);
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

  /**
   * Ask the orchestrator whether the company's data is connected.
   *
   * Failure is deliberately silent. This is a side channel: if it cannot be answered, the control
   * simply stays as it was, and nothing about building a plugin depends on it. An alert here would
   * be the second one on screen for a backend that is already reported as unreachable.
   */
  const refreshMcp = useCallback(async (signal: AbortSignal) => {
    try {
      setMcp(await getMcpStatus(signal));
    } catch {
      // Left as-is on purpose. See above.
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void refreshMcp(abort.signal);
    return () => abort.abort();
  }, [refreshMcp]);

  /** Stop watching for a connection, whether it arrived or the user walked away. */
  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setConnecting(false);
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  /**
   * Connect the company's data in one click.
   *
   * The tab is opened directly with a fixed url rather than fetching one first and opening it
   * second — that second form is exactly what a popup blocker catches. The orchestrator answers
   * it with a redirect to Unimicro's broker, and because this browser is already signed in to
   * Unimicro, what the user sees is a consent screen rather than a login.
   *
   * Then poll. The flow finishes in that other tab, out of this view's sight: nothing calls back
   * here, so asking repeatedly is the only way to notice. It stops on success or after
   * CONNECT_WINDOW_MS, because a user who closed the tab is not coming back and a timer that
   * never ends is a leak.
   */
  const connectData = useCallback(() => {
    window.open(mcpLoginUrl(), "_blank", "noopener");
    setConnecting(true);

    const startedAt = Date.now();
    if (pollRef.current !== null) window.clearInterval(pollRef.current);

    pollRef.current = window.setInterval(() => {
      void (async () => {
        const abort = new AbortController();
        try {
          const next = await getMcpStatus(abort.signal);
          setMcp(next);
          if (next.connected) stopPolling();
        } catch {
          // Keep polling. A single failed check mid-sign-in means nothing.
        }
        if (Date.now() - startedAt > CONNECT_WINDOW_MS) stopPolling();
      })();
    }, CONNECT_POLL_MS);
  }, [stopPolling]);

  const phase = PHASE_OF[state];
  const working = phase === "build" || phase === "check";
  const starting = phase === "prepare";
  const waiting = working || starting;
  const ready = phase === "done";

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

  /**
   * As many examples as the stage can show whole — see the `room` effect. None at all on the
   * shortest frames, where the question and the field are what there is room for, and the field's
   * own placeholder says the same thing an example would.
   */
  const examples =
    room === "full"
      ? SUGGESTIONS
      : room === "tight"
        ? SUGGESTIONS.slice(0, 2)
        : [];

  const chatter = CHATTER[phase ?? "build"];
  const message = offline
    ? "Mistet kontakt med verkstedet — kobler til på nytt…"
    : chatter[beat % chatter.length];
  const slow = working && elapsed >= SLOW_AFTER;

  const submit = useCallback(
    (text?: string) => {
      const value = (text ?? composer.current?.value ?? "").trim();
      const signal = abortRef.current?.signal;
      if (!value || !sessionId || !signal || waiting) return;
      if (composer.current && !text) composer.current.value = "";

      const at = Date.now();
      setRequest(value);
      setSummary(null);
      setError(null);
      setBeat(0);
      setStartedAt(at);
      // Optimistic: the state event that confirms it is a round trip away, and a composer
      // that clears into an unchanged screen reads as a dropped request.
      stateRef.current = "working";
      setState("working");
      // Written before the request is even accepted, so a reload during the round trip still
      // finds its way back to the turn it started.
      remember({ id: sessionId, request: value, startedAt: at });

      void sendMessage(sessionId, value, model, effort, signal).catch(
        (cause: unknown) => {
          if ((cause as Error).name === "AbortError") return; // the view is gone
          setError(String(cause));
          stateRef.current = "failed";
          setState("failed");
        },
      );
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

  const openPlugin = useCallback(
    async (url: string) => {
      try {
        // openExternal, not navigateTo: the platform binds tunnelId for the life of a tab,
        // and this chat is itself served through a tunnel in this one. A new tab picks up
        // the generated plugin's tunnel without disturbing ours.
        await host.navigation.openExternal(url);
      } catch (cause) {
        if (isHostError(cause) && cause.code === "host/revoked") return; // the user left
        // This button is the only way through — the URL used to be printed beside it as a
        // fallback and is not any more — so a refusal has to be said out loud rather than
        // logged and forgotten.
        host.notifications.error("Kunne ikke åpne pluginen");
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
    <div className="progress" role="group" aria-label="Byggefremdrift">
      <uni-stepper horizontal class="rail">
        {STEPS.map(({ phase: step, name }, i) => (
          <uni-step
            key={step}
            name={name}
            active={(i === at && phase !== "done") || undefined}
            completed={(at >= 0 && (i < at || phase === "done")) || undefined}
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
    <div className={ready ? "open open--ready" : "open"}>
      <uni-button
        variant={ready ? "primary" : "secondary"}
        small={!ready || undefined}
        onClick={() => openPlugin(previewUrl)}
      >
        Åpne pluginen din
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
      <h1 className="title">Plugin-fabrikken</h1>

      {unreachable && (
        <uni-alert type="critical" header="Kan ikke nå plugin-fabrikken">
          Ingenting svarer på {base()}. Start orkestratoren, og prøv igjen.
          <uni-button slot="actions" variant="secondary" small onClick={retry}>
            Prøv igjen
          </uni-button>
        </uni-alert>
      )}

      {offline && !unreachable && (
        <uni-alert type="warning" header="Mistet kontakt med plugin-fabrikken">
          Kobler til på nytt. Alt som allerede kjører fortsetter uten oss.
        </uni-alert>
      )}

      {/* Shown only when there is something to click. Not a row in the composer's settings
          beside Model and Effort: those are per-turn choices that ride along with the next
          request, while this is a one-time machine-level credential the orchestrator holds
          for every session. Putting it there would have implied it changes per turn. And
          once connected there is nothing to say — a permanent "connected" badge is clutter
          on the one screen whose whole job is to keep a single question in view. */}
      {mcp && !mcp.connected && !unreachable && (
        <uni-alert
          type={mcp.expired ? "warning" : "info"}
          header={
            mcp.expired
              ? "Koble til firmadataene dine på nytt"
              : "La fabrikken sjekke arbeidet sitt mot dataene dine"
          }
        >
          {mcp.expired
            ? "Tilkoblingen har utløpt. Det tar bare et klikk å koble til på nytt — du er allerede innlogget."
            : "Når den er tilkoblet, kan den bekrefte at en side spør om riktig ting i stedet for å gjette. Åpner et samtykkevindu i en ny fane."}
          <uni-button
            slot="actions"
            variant="secondary"
            small
            loading={connecting || undefined}
            onClick={connectData}
          >
            {connecting
              ? "Venter på den andre fanen…"
              : mcp.expired
                ? "Koble til på nytt"
                : "Koble til"}
          </uni-button>
        </uni-alert>
      )}

      {error && (
        <uni-alert type="critical" header="Det gikk ikke">
          {error}
          <uni-button
            slot="actions"
            variant="secondary"
            small
            onClick={startOver}
          >
            Start på nytt
          </uni-button>
        </uni-alert>
      )}

      <div className="stage" ref={stageEl} data-room={room}>
        {/* The log takes the stage while it is open, rather than opening downwards in the
            composer: this is the only row that can give up its height, so it is the only place
            something this tall can go without pushing the field off the bottom of the frame. It
            is also the only thing in the view allowed to scroll. */}
        {logOpen ? (
          <div className="console">
            <pre ref={logEl}>{log.join("\n")}</pre>
          </div>
        ) : (
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
                      ? "Tar lengre tid enn vanlig. Det kan fortsatt bli ferdig, eller du kan starte på nytt."
                      : "Fortsatt i gang — dette tar vanligvis et minutt eller to."}
                  </span>
                  {/* Deliberately outside the live region: a value that changes once
                                      a second inside one makes a screen reader re-read the whole
                                      block once a second. */}
                  <span aria-hidden="true">{clock(elapsed)}</span>
                </p>

                {open}
              </div>
            ) : ready ? (
              <div className="wait wait--done">
                <span className="tick" aria-hidden="true">
                  ✓
                </span>
                <div className="live" aria-live="polite">
                  <p className="message">Pluginen din er klar</p>
                </div>
                {summary && <p className="summary">{summary}</p>}
                {open}
                <p className="reassure">
                  Be om en ny endring nedenfor når du vil.
                </p>
              </div>
            ) : (
              <div className="intro">
                {/* One question, asked once. The "in plain language" half of what used
                                  to be two near-identical lines now lives in the composer's
                                  placeholder, where it is read at the moment it is acted on. */}
                <h2>Hva skal pluginen din gjøre?</h2>
                {room === "full" && <p className="label">For eksempel</p>}
                {/* Fewer of them on a short frame, rather than three of them with the last one
                                  cut off halfway down. An example is only a way in while it can be
                                  read and clicked, and the field below says how to write one. */}
                {examples.length > 0 && (
                  <div className="suggestions">
                    {examples.map((s) => (
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
                )}
                {starting && (
                  <p className="reassure" aria-live="polite">
                    <span className="dots" aria-hidden="true" />
                    {message} Klar for din første forespørsel om et øyeblikk.
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
        )}
      </div>

      <div
        className="composer"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      >
        {/* The handle, kept above the settings row where the rest of the quiet per-turn controls
                    are; what it opens appears directly overhead, in the stage. A disclosure that
                    opened downwards from here — `uni-details` did — adds its height to the one row
                    that has none to give, and the field goes off the bottom of the frame with it. */}
        {log.length > 0 && (
          <div className="composer__log">
            <uni-button
              variant="tertiary"
              xs
              aria-expanded={logOpen}
              onClick={() => setLogOpen((open) => !open)}
            >
              {logOpen ? "Skjul tekniske detaljer" : "Tekniske detaljer"}
            </uni-button>
          </div>
        )}
        {/* Apply to the next turn, not the session — the view sends them along with each
                    request rather than fixing them at session creation, so changing either never
                    means starting over. Menus, not comboboxes: there is no filtering to do over a
                    handful of fixed options, and a text field invites typing one that does not
                    exist. `tertiary xs` keeps both to the size of a label, not a form control — this
                    is a quiet per-turn setting, not an action competing with Send. Disabled rather
                    than merely inert while a turn runs, matching the textarea below. */}
        <div className="composer__settings">
          <div className="composer__setting">
            <span className="composer__setting-label">Modell</span>
            <uni-dropdown-menu placement="bottom-start">
              <uni-button
                slot="toggle"
                variant="tertiary"
                xs
                caret
                disabled={waiting || undefined}
              >
                {MODELS.find((m) => m.id === model)?.label ?? model}
              </uni-button>
              <uni-menu
                onuni-select={(event: any) =>
                  selectModel(event.detail.dataset.model as ModelId)
                }
              >
                {MODELS.map((m) => (
                  <uni-menu-item
                    key={m.id}
                    data-model={m.id}
                    selected={m.id === model || undefined}
                  >
                    {m.label}
                  </uni-menu-item>
                ))}
              </uni-menu>
            </uni-dropdown-menu>
          </div>
          <div className="composer__setting">
            <span className="composer__setting-label">Innsats</span>
            <uni-dropdown-menu placement="bottom-start">
              <uni-button
                slot="toggle"
                variant="tertiary"
                xs
                caret
                disabled={waiting || undefined}
              >
                {EFFORTS.find((e) => e.id === effort)?.label ?? effort}
              </uni-button>
              <uni-menu
                onuni-select={(event: any) =>
                  selectEffort(event.detail.dataset.effort as Effort)
                }
              >
                {EFFORTS.map((e) => (
                  <uni-menu-item
                    key={e.id}
                    data-effort={e.id}
                    selected={e.id === effort || undefined}
                  >
                    {e.label}
                  </uni-menu-item>
                ))}
              </uni-menu>
            </uni-dropdown-menu>
          </div>
        </div>
        {/* The placeholder is not an example. A fifth one here, absent from the curated
                    three above, made the whole set look generated rather than chosen; this says
                    how to write instead, which is the half of the old intro copy worth keeping. */}
        <div className="composer__field">
          <uni-textarea
            ref={composer}
            label="Beskriv pluginen du vil ha"
            label-hidden
            resize="auto"
            readonly={waiting || undefined}
            placeholder={
              waiting
                ? "Arbeider med det…"
                : "Beskriv en side eller en endring, med vanlige ord…"
            }
          />
          {/* Beside the field rather than under it, so it reads as part of the same
                        control instead of a separate row. While a turn is running, Stop takes this
                        same spot instead of sitting down in the working panel — it is the field's
                        button either way, just aimed at whichever action applies right now. */}
          <div className="composer__send">
            {working ? (
              <uni-button variant="destructive" small onClick={startOver}>
                Stopp
              </uni-button>
            ) : (
              /* Secondary for exactly one state. Two filled blue buttons were on screen at
                                the moment a build landed — this one and "Open your plugin" — both reading
                                as the primary action while doing unrelated things. Iterating is the more
                                frequent action and keeps the primary everywhere else; on the ready screen
                                the payoff outranks it for one beat, and stepping this down is what says
                                so. The label goes with it: "Build it" is what a first-time reader is
                                actually doing, and "Send" only makes sense once there is something to
                                send a change to. */
              <uni-button
                variant={ready ? "secondary" : "primary"}
                disabled={waiting || undefined}
                onClick={() => submit()}
              >
                {built ? "Send" : "Bygg den"}
              </uni-button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
