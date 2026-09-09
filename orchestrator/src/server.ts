import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { EventBus } from './bus.ts';
import { LocalRunner, type PluginTarget, type Runner, type VerifyResult } from './runner.ts';
import { VercelRunner } from './vercel-runner.ts';
import type { SessionSnapshot, SessionState } from './protocol.ts';
import { mcpStatus } from './unimicro-mcp.ts';
import { begin, complete, type Pending } from './mcp-auth.ts';

/**
 * How many times the harness will hand a failing gate straight back to the agent before giving up
 * and telling the human. Without this, "the user pastes the error back in" *is* the product — this
 * is that loop, automated.
 */
const MAX_REPAIR_ROUNDS = 3;

/**
 * Bound to 127.0.0.1 deliberately.
 *
 * This service has no authentication and cannot have any worth the name: a plugin view's
 * getContext() is unsigned plain JSON with no token, and the platform has no way for a view to
 * prove who it is to a third party. Loopback-only is the one mitigation with actual teeth, and it
 * is why the prototype is single-user by construction.
 */
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8787);

const TARGET: PluginTarget = {
    dir: resolve(process.env.FACTORY_PLUGIN_DIR ?? '../factory-demo-alfa'),
    pluginId: process.env.FACTORY_PLUGIN_ID ?? 'factory-demo-alfa',
};

/**
 * What the chat view is allowed to ask for.
 *
 * Kept as a fixed allowlist rather than passing the client's string straight through: the value
 * ends up as a spawned process's argv, and validating it here means an unrecognised or malformed
 * value falls back to `run.mjs`'s own default instead of failing the turn.
 */
const ALLOWED_MODELS = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5']);
const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizeModel(model: unknown): string | undefined {
    return typeof model === 'string' && ALLOWED_MODELS.has(model) ? model : undefined;
}

function normalizeEffort(effort: unknown): string | undefined {
    return typeof effort === 'string' && ALLOWED_EFFORTS.has(effort) ? effort : undefined;
}

type Session = {
    id: string;
    state: SessionState;
    bus: EventBus;
    runner: Runner;
    previewUrl: string | null;
    agentSessionId: string | undefined;
    /** Turns are serialised: the agent edits a working tree, and two at once would race. */
    queue: Promise<void>;
};

const sessions = new Map<string, Session>();

/** One at a time. The demo plugin is a single working tree with a single dev port. */
let active: Session | null = null;

/**
 * Where the work happens.
 *
 * Vercel Sandbox is used when it is configured, and the laptop otherwise. The two are
 * interchangeable by construction: the server, the event contract and the chat view never learn
 * which one they got, so the cloud path can be switched on without touching them.
 */
function makeRunner(): Runner {
    const configured = Boolean(process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN);

    if (configured) {
        console.log('runner: vercel sandbox');
        return new VercelRunner(TARGET);
    }

    console.log('runner: local (set VERCEL_TOKEN or VERCEL_OIDC_TOKEN to use the sandbox)');
    return new LocalRunner(TARGET);
}

function setState(session: Session, state: SessionState, detail?: string): void {
    session.state = state;
    session.bus.emit({ type: 'session.state', state, detail });
}

async function createSession(): Promise<Session> {
    if (active) {
        await disposeSession(active);
    }

    const session: Session = {
        id: randomUUID(),
        state: 'created',
        bus: new EventBus(),
        runner: makeRunner(),
        previewUrl: null,
        agentSessionId: undefined,
        queue: Promise.resolve(),
    };

    sessions.set(session.id, session);
    active = session;
    return session;
}

async function disposeSession(session: Session): Promise<void> {
    await session.runner.dispose().catch(() => {});
    session.bus.closeAll();
    sessions.delete(session.id);
    if (active === session) active = null;
}

/**
 * Bring the plugin up before the agent writes a line.
 *
 * The scaffold already renders, so the user gets a real, live plugin in their own company within
 * about thirty seconds and then watches it turn into the thing they asked for. Showing them the
 * working plugin early is worth more than any amount of streaming polish later.
 */
async function provision(session: Session): Promise<void> {
    setState(session, 'provisioning', 'resetting the demo plugin');
    await session.runner.reset();

    setState(session, 'dev-starting', 'connecting to your test company');
    await session.runner.startDev(session.bus);

    setState(session, 'live', 'the plugin is running — tell me what to build');
}

/** What the agent gets told when a gate it thought it passed turns out not to have. */
function repairPrompt(failed: VerifyResult): string {
    return [
        `The \`${failed.step}\` gate failed after your last change:`,
        '',
        '```',
        failed.output.slice(-4000),
        '```',
        '',
        'Fix the underlying problem, then re-run all four gates from the top, in order — npm run ' +
            'check, npm test, npm run build, unimicro plugin validate --json — since a fix for this ' +
            'one can regress one that was already passing. Do not finish this turn until all four are ' +
            'green.',
    ].join('\n');
}

async function handleTurn(
    session: Session,
    text: string,
    model: string | undefined,
    effort: string | undefined,
): Promise<void> {
    try {
        if (session.state === 'created') await provision(session);

        let prompt = text;
        let usd = 0;
        let turns = 0;
        let results: VerifyResult[] = [];
        let failed: VerifyResult | undefined;

        // The agent is asked to verify as it goes, but asking is not the same as knowing. The gate
        // runs independently here, and on failure the agent gets the real output back and another
        // turn to fix it — up to MAX_REPAIR_ROUNDS times — before a human ever sees the error.
        for (let attempt = 0; attempt <= MAX_REPAIR_ROUNDS; attempt += 1) {
            setState(
                session,
                'working',
                attempt === 0 ? undefined : `auto-fixing ${failed?.step} (attempt ${attempt}/${MAX_REPAIR_ROUNDS})`,
            );
            const result = await session.runner.runTurn(
                session.bus,
                prompt,
                session.agentSessionId,
                model,
                effort,
            );
            session.agentSessionId = result.sessionId;
            usd += result.usd ?? 0;
            turns += result.turns ?? 0;

            setState(session, 'verifying');
            results = await session.runner.verify(session.bus);
            failed = results.find((r) => !r.ok);

            if (!failed) break;
            if (attempt === MAX_REPAIR_ROUNDS) break;
            prompt = repairPrompt(failed);
        }

        setState(
            session,
            failed ? 'failed' : 'updated',
            failed
                ? `${failed.step} is still failing after ${MAX_REPAIR_ROUNDS} automatic fix attempts — see the log above`
                : 'change is live — refresh the plugin tab',
        );
        session.bus.emit({ type: 'turn.done', usd, turns });
    } catch (error) {
        session.bus.emit({ type: 'error', message: String(error), fatal: true });
        setState(session, 'failed');
    }
}

/**
 * The one authorization in flight, if any.
 *
 * A module-level single, like `active`: this service is loopback-only and single-user by
 * construction, and the redirect uri is one fixed string. Two overlapping flows would race on the
 * same callback anyway, so the second start replaces the first rather than pretending otherwise.
 */
let pendingMcp: Pending | null = null;

/** How long a started flow stays claimable before the callback is treated as stale. */
const MCP_FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * Where the broker sends the browser back.
 *
 * A route on this server rather than a listener of its own: there is already an HTTP server on this
 * port, the browser is already talking to it, and one fewer port is one fewer thing to be in use.
 * It must be literally this string — the server matches the redirect uri exactly, and it is baked
 * into the client registration keyed by it.
 *
 * `FACTORY_PUBLIC_ORIGIN` is what makes this deployable rather than laptop-only. Set it to the
 * origin a browser reaches this service at — `https://factory.example.com` — and the callback, the
 * client registration and the redirect all follow, with no other change anywhere. Left unset it is
 * loopback, which is the right default while the tunnel credential still has to come off a
 * developer's machine.
 *
 * It has to be the *browser's* view of this service, not the socket's: behind a proxy or a tunnel
 * those differ, and a redirect uri built from the socket sends the user to a host only the server
 * can see. That failure arrives as an invalid_redirect_uri from the broker, which reads like a
 * registration problem rather than a configuration one.
 */
const PUBLIC_ORIGIN = (process.env.FACTORY_PUBLIC_ORIGIN ?? `http://${HOST}:${PORT}`).replace(
    /\/+$/,
    '',
);
const MCP_REDIRECT_URI = `${PUBLIC_ORIGIN}/api/mcp/callback`;

/** A small self-closing page for the tab the user was sent to. */
function mcpCallbackPage(res: ServerResponse, heading: string, detail: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
        `<!doctype html><meta charset="utf-8"><title>${heading}</title>` +
            '<body style="font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh">' +
            `<div style="text-align:center;max-width:28rem;padding:2rem">` +
            `<h1 style="font-size:1.25rem;margin:0 0 .5rem">${heading}</h1>` +
            `<p style="margin:0;color:#555">${detail}</p></div>` +
            // Best-effort. A tab the browser did not open via script cannot close itself, and the
            // copy above has to stand on its own for exactly that case.
            '<script>setTimeout(function(){window.close()},1200)</script>',
    );
}

function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((done, fail) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 100_000) fail(new Error('body too large'));
        });
        req.on('end', () => done(body));
        req.on('error', fail);
    });
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    const path = url.pathname;

    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (path === '/healthz') return json(res, 200, { ok: true, active: active?.id ?? null });

    if (req.method === 'POST' && path === '/api/sessions') {
        const session = await createSession();
        // Provision in the background so the POST returns immediately and the view can open the
        // stream in time to watch it happen.
        session.queue = session.queue.then(() =>
            provision(session).catch((error) => {
                session.bus.emit({ type: 'error', message: String(error), fatal: true });
                setState(session, 'failed');
            }),
        );
        return json(res, 201, { sessionId: session.id, pluginId: TARGET.pluginId });
    }

    // Connecting the agent to the company's own data. Three routes and no session: this is a
    // machine-level credential, shared by every session the orchestrator runs.
    if (req.method === 'GET' && path === '/api/mcp') {
        return json(res, 200, await mcpStatus());
    }

    /**
     * Start the flow by redirecting the browser at the broker.
     *
     * A redirect rather than a JSON endpoint returning the url, because the caller is a plugin view
     * in a browser that is already signed in to Unimicro: it opens this in a tab, the broker sees
     * the existing session, and consent is a click. Handing the view a url to open in a second step
     * would just give a popup blocker something to catch.
     */
    if (req.method === 'GET' && path === '/api/mcp/login') {
        try {
            const { url, pending } = await begin(MCP_REDIRECT_URI);
            pendingMcp = pending;
            res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
            return res.end();
        } catch (error) {
            return mcpCallbackPage(
                res,
                'Could not start the sign-in',
                String(error instanceof Error ? error.message : error),
            );
        }
    }

    if (req.method === 'GET' && path === '/api/mcp/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const failure = url.searchParams.get('error');
        const pending = pendingMcp;
        pendingMcp = null;

        if (failure) {
            return mcpCallbackPage(res, 'Sign-in was not completed', 'You can close this tab.');
        }
        if (!pending || Date.now() - pending.startedAt > MCP_FLOW_TTL_MS) {
            return mcpCallbackPage(
                res,
                'That sign-in had already expired',
                'Close this tab and press Connect again.',
            );
        }
        // A mismatched state is not the response we asked for. Refuse it rather than exchanging a
        // code that arrived from somewhere else.
        if (state !== pending.state || !code) {
            return mcpCallbackPage(res, 'Unexpected response', 'Close this tab and try again.');
        }

        try {
            await complete(code, pending);
            console.log('mcp: connected');
            return mcpCallbackPage(
                res,
                'Connected',
                'The factory can read your company data now. You can close this tab.',
            );
        } catch (error) {
            return mcpCallbackPage(
                res,
                'Could not finish the sign-in',
                String(error instanceof Error ? error.message : error),
            );
        }
    }

    const match = /^\/api\/sessions\/([^/]+)(\/[a-z]+)?$/.exec(path);
    if (match) {
        const session = sessions.get(match[1]);
        if (!session) return json(res, 404, { error: 'no such session' });

        const sub = match[2];

        if (req.method === 'GET' && sub === '/events') {
            const header = req.headers['last-event-id'];
            const last = header ? Number(header) : Number(url.searchParams.get('lastEventId')) || null;
            return session.bus.attach(res, Number.isFinite(last) ? last : null);
        }

        if (req.method === 'POST' && sub === '/messages') {
            const { text, model, effort } = JSON.parse((await readBody(req)) || '{}');
            if (!text?.trim()) return json(res, 400, { error: 'text is required' });

            // 202 and get out of the way: everything the user sees arrives on the stream.
            json(res, 202, { accepted: true });
            session.queue = session.queue.then(() =>
                handleTurn(session, text, normalizeModel(model), normalizeEffort(effort)),
            );
            return;
        }

        // Runs the gate on its own, without an agent turn. Useful when the agent is unavailable,
        // and the fastest way to see whether the working tree is currently shippable.
        if (req.method === 'POST' && sub === '/verify') {
            json(res, 202, { accepted: true });
            session.queue = session.queue.then(async () => {
                setState(session, 'verifying');
                const results = await session.runner.verify(session.bus);
                const failed = results.find((r) => !r.ok);
                setState(session, failed ? 'failed' : 'updated', failed ? `${failed.step} failed` : 'all gates green');
            });
            return;
        }

        if (req.method === 'POST' && sub === '/stop') {
            await disposeSession(session);
            return json(res, 200, { stopped: true });
        }

        if (req.method === 'GET' && !sub) {
            const snapshot: SessionSnapshot = {
                sessionId: session.id,
                state: session.state,
                pluginId: TARGET.pluginId,
                previewUrl: session.previewUrl,
                events: session.bus.history,
            };
            return json(res, 200, snapshot);
        }
    }

    return json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
    console.log(`plugin-factory orchestrator on http://${HOST}:${PORT}`);
    if (PUBLIC_ORIGIN !== `http://${HOST}:${PORT}`) console.log(`  public  ${PUBLIC_ORIGIN}`);
    console.log(`  plugin  ${TARGET.pluginId}`);
    console.log(`  dir     ${TARGET.dir}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
        if (active) await disposeSession(active);
        server.close(() => process.exit(0));
    });
}
