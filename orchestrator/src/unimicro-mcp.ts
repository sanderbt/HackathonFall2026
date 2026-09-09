import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The Unimicro MCP server, as a credential this harness can hand to the sandbox agent.
 *
 * Why the agent gets this at all: the four gates cannot see whether a `host.api` query is *right*.
 * A wrong entity route, a wrong field name or an unsupported filter operator comes back 200 with an
 * empty array or the whole unfiltered collection, and check/test/build/validate all pass on it.
 * The skills carry the field names statically; MCP is the only thing here that can confirm a query
 * against the actual test company. That is the entire reason it is wired in.
 *
 * Why the token arrives as a value rather than being fetched here: the server's own metadata
 * advertises `grant_types_supported: ["authorization_code"]` and nothing else — no
 * client-credentials, no service account — so a token cannot be minted without a person at a
 * browser. `npm run mcp-login` is that person's one-time step; this module only reads the result.
 *
 * The Unimicro CLI session that `vercel-runner.ts` injects for the tunnel is NOT usable here: the
 * MCP endpoint rejects it with a 401 and a `WWW-Authenticate` pointing at its own resource
 * metadata, because it is a separate resource with a separate registration. Two doors, two keys.
 */

/** Overridable so a later lane (or a local server) needs no code change. */
export const MCP_URL = process.env.UNIMICRO_MCP_URL ?? 'https://test-mcp.unimicro.app/mcp';

/** Where `mcp-login` leaves its result. Gitignored — it holds a live access token. */
export const TOKEN_FILE = fileURLToPath(new URL('../.unimicro-mcp.json', import.meta.url));

type Store = {
    access_token?: string;
    token_type?: string;
    scope?: string;
    expires_in?: number;
    obtained_at?: number;
    url?: string;
    /** Registered client ids, keyed by redirect uri — see `mcp-auth.ts`'s `registerClient`. */
    clients?: Record<string, string>;
};

/** The file as it is, or an empty store. A missing file is a state, not a failure. */
export async function readStore(): Promise<Store> {
    try {
        return JSON.parse(await readFile(TOKEN_FILE, 'utf8')) as Store;
    } catch {
        return {};
    }
}

/**
 * Merge a patch into the file.
 *
 * Merged rather than replaced because two different things write here — a token from a completed
 * exchange, and a client registration from a first login on a given redirect — and neither should
 * erase the other. Mode 0600: this holds a live access token.
 */
export async function writeStore(patch: Store): Promise<void> {
    const next = { ...(await readStore()), ...patch };
    await writeFile(TOKEN_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
}

/** When the stored token stops being usable, or null if there is nothing to judge. */
function expiryOf(store: Store): number | null {
    if (!store.obtained_at || !store.expires_in) return null;
    return store.obtained_at + store.expires_in * 1000;
}

/** What the view needs to render its connect control. Never includes the token itself. */
export type McpStatus = {
    connected: boolean;
    url: string;
    /** Epoch ms, or null when the server sent no lifetime. */
    expiresAt: number | null;
    /** True when a token exists but has aged out — a different message from never having one. */
    expired: boolean;
};

export async function mcpStatus(): Promise<McpStatus> {
    const store = await readStore();
    const expiresAt = expiryOf(store);
    const hasToken = Boolean(process.env.UNIMICRO_MCP_TOKEN?.trim() || store.access_token);
    const expired = Boolean(
        store.access_token && expiresAt !== null && Date.now() > expiresAt - EXPIRY_SLACK_MS,
    );

    return { connected: hasToken && !expired, url: MCP_URL, expiresAt, expired };
}

/** Treat a token as spent slightly early: a turn can run for minutes after this check. */
const EXPIRY_SLACK_MS = 5 * 60 * 1000;

/**
 * The token, from the environment or from the login file — or null, meaning "run without MCP".
 *
 * Absence is not an error. The harness degrades the same way it does without Vercel credentials:
 * everything still works, the agent just loses live verification. What *would* be an error is
 * handing the agent an expired token, because that fails as tool calls 401-ing mid-turn, which the
 * agent will read as "no data" and report as an empty result. So an expired token is discarded here
 * and said out loud instead.
 */
export async function readMcpToken(): Promise<string | null> {
    const fromEnv = process.env.UNIMICRO_MCP_TOKEN?.trim();
    if (fromEnv) return fromEnv;

    const stored = await readStore();
    if (!stored.access_token) return null; // Never logged in on this machine. Fine.

    const expiresAt = expiryOf(stored);
    if (expiresAt !== null && Date.now() > expiresAt - EXPIRY_SLACK_MS) {
        console.warn(
            '[mcp] The Unimicro MCP token expired. Reconnect from the plugin view, or run ' +
                '`npm run mcp-login`. Continuing without MCP — the agent will fall back to reading ' +
                'the platform-api reference instead of verifying queries live.',
        );
        return null;
    }

    return stored.access_token;
}

/**
 * The environment `run.mjs` needs to attach the MCP server, or `{}` to leave it unattached.
 *
 * Both Runners call this and merge the result into the agent process's environment, so the local
 * and sandbox paths get an identical agent — which is the property the whole two-Runner design
 * rests on.
 */
export async function mcpAgentEnv(): Promise<Record<string, string>> {
    const token = await readMcpToken();
    if (!token) return {};

    return {
        UNIMICRO_MCP_URL: MCP_URL,
        UNIMICRO_MCP_TOKEN: token,
        // Off unless asked for. The docs are explicit that writes in a test company are real
        // writes, and an agent that can post a journal entry while iterating on a view is a bigger
        // blast radius than this prototype needs by default.
        ...(process.env.UNIMICRO_MCP_ALLOW_WRITES === '1' ? { UNIMICRO_MCP_ALLOW_WRITES: '1' } : {}),
    };
}
