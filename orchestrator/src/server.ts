import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { EventBus } from './bus.ts';
import { LocalRunner, type PluginTarget, type Runner } from './runner.ts';
import { VercelRunner } from './vercel-runner.ts';
import { runAgentTurn } from './agent.ts';
import type { SessionSnapshot, SessionState } from './protocol.ts';

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
    const repo = process.env.FACTORY_REPO_URL;
    const configured = Boolean(process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN);

    if (configured && repo) {
        console.log('runner: vercel sandbox');
        return new VercelRunner(TARGET, repo, process.env.GITHUB_TOKEN);
    }

    console.log(
        configured
            ? 'runner: local (set FACTORY_REPO_URL to use the sandbox)'
            : 'runner: local (set VERCEL_TOKEN or VERCEL_OIDC_TOKEN to use the sandbox)',
    );
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

async function handleTurn(session: Session, text: string): Promise<void> {
    try {
        if (session.state === 'created') await provision(session);

        setState(session, 'working');
        const result = await runAgentTurn(TARGET, text, session.bus, session.agentSessionId);
        session.agentSessionId = result.sessionId;

        // The agent is asked to verify, but asking is not the same as knowing. The gate runs
        // independently so "done" means the four commands actually passed.
        setState(session, 'verifying');
        const results = await session.runner.verify(session.bus);
        const failed = results.find((r) => !r.ok);

        setState(
            session,
            failed ? 'failed' : 'updated',
            failed ? `${failed.step} failed` : 'change is live — refresh the plugin tab',
        );
        session.bus.emit({ type: 'turn.done', usd: result.usd, turns: result.turns });
    } catch (error) {
        session.bus.emit({ type: 'error', message: String(error), fatal: true });
        setState(session, 'failed');
    }
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
            const { text } = JSON.parse((await readBody(req)) || '{}');
            if (!text?.trim()) return json(res, 400, { error: 'text is required' });

            // 202 and get out of the way: everything the user sees arrives on the stream.
            json(res, 202, { accepted: true });
            session.queue = session.queue.then(() => handleTurn(session, text));
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
    console.log(`  plugin  ${TARGET.pluginId}`);
    console.log(`  dir     ${TARGET.dir}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
        if (active) await disposeSession(active);
        server.close(() => process.exit(0));
    });
}
