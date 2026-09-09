/**
 * The OAuth mechanics for the Unimicro MCP server, with no opinion about who drives them.
 *
 * Two callers need the same flow with a different redirect: `mcp-login.ts` runs it from a terminal
 * against its own loopback listener, and `server.ts` runs it from a button in the plugin view
 * against a route on the orchestrator itself. Everything they share lives here; the only thing they
 * differ on is the redirect uri, which is a parameter.
 *
 * The flow is fixed by the server, not chosen by us. Its metadata advertises
 * `grant_types_supported: ["authorization_code"]` and `token_endpoint_auth_methods_supported:
 * ["none"]` — a public client with PKCE and a person at a browser. There is no client-credentials
 * grant, token exchange is refused outright ("Only authorization_code is supported on the broker
 * token endpoint"), and the Unimicro CLI session is a different resource that this endpoint answers
 * with a 401. So a browser round-trip is not a shortcut we failed to find; it is the whole protocol.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { MCP_URL, readStore, writeStore } from './unimicro-mcp.ts';

type AuthServerMetadata = {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
};

/** One in-flight authorization, held between the redirect out and the callback back. */
export type Pending = {
    state: string;
    verifier: string;
    clientId: string;
    redirectUri: string;
    startedAt: number;
};

const base64url = (buffer: Buffer) => buffer.toString('base64url');

/**
 * Ask the resource what protects it, then ask that server where its endpoints are.
 *
 * Hardcoding the two endpoints would work today and break silently the day the broker moves, which
 * is the kind of failure that reads as "MCP is down" rather than "the metadata changed".
 */
export async function discover(): Promise<{ metadata: AuthServerMetadata; scope: string }> {
    const resource = new URL(MCP_URL);
    const prmUrl = new URL(
        `/.well-known/oauth-protected-resource${resource.pathname}`,
        resource.origin,
    );

    const prmResponse = await fetch(prmUrl);
    if (!prmResponse.ok) {
        throw new Error(`${prmUrl} answered ${prmResponse.status}. Is ${MCP_URL} the right server?`);
    }

    const prm = (await prmResponse.json()) as {
        authorization_servers?: string[];
        scopes_supported?: string[];
    };

    const issuer = prm.authorization_servers?.[0];
    if (!issuer) throw new Error(`${prmUrl} named no authorization_servers.`);

    const asResponse = await fetch(new URL('/.well-known/oauth-authorization-server', issuer));
    if (!asResponse.ok) throw new Error(`${issuer} has no OAuth metadata (${asResponse.status}).`);

    const metadata = (await asResponse.json()) as AuthServerMetadata;
    const scope = (prm.scopes_supported ?? metadata.scopes_supported ?? ['openid']).join(' ');
    return { metadata, scope };
}

/**
 * A client id for this redirect, registered on first use and remembered after.
 *
 * Keyed on the redirect uri because the server matches it as an exact string: a client registered
 * for the CLI's port is not the client the server's own callback route can use. Storing them per
 * redirect lets both paths exist without re-registering each other away every time they alternate.
 */
export async function registerClient(redirectUri: string, scope: string): Promise<string> {
    const store = await readStore();
    const known = store.clients?.[redirectUri];
    if (known) return known;

    const { metadata } = await discover();
    if (!metadata.registration_endpoint) {
        throw new Error('The server advertises no registration endpoint, so no client can be created.');
    }

    const response = await fetch(metadata.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: 'plugin-factory orchestrator (local)',
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope,
        }),
    });

    if (!response.ok) {
        throw new Error(`Registration failed (${response.status}): ${await response.text()}`);
    }

    const registered = (await response.json()) as { client_id?: string };
    if (!registered.client_id) throw new Error('Registration returned no client_id.');

    await writeStore({ clients: { ...(store.clients ?? {}), [redirectUri]: registered.client_id } });
    return registered.client_id;
}

/** Everything needed to send a browser to the broker, plus what the callback will have to match. */
export async function begin(redirectUri: string): Promise<{ url: string; pending: Pending }> {
    const { metadata, scope } = await discover();
    const clientId = await registerClient(redirectUri, scope);

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = randomUUID();

    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // RFC 8707. The MCP spec requires it, and a broker fronting several resources needs it to know
    // which one the token is being minted for.
    url.searchParams.set('resource', MCP_URL);

    return {
        url: url.toString(),
        pending: { state, verifier, clientId, redirectUri, startedAt: Date.now() },
    };
}

/**
 * Trade the code for a token and persist it.
 *
 * `token_endpoint_auth_method: none` means there is no secret to send; PKCE is what proves this is
 * the same client that started the flow.
 */
export async function complete(code: string, pending: Pending): Promise<{ expiresIn?: number }> {
    const { metadata } = await discover();

    const response = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: pending.redirectUri,
            client_id: pending.clientId,
            code_verifier: pending.verifier,
            resource: MCP_URL,
        }),
    });

    if (!response.ok) {
        throw new Error(`Token exchange failed (${response.status}): ${await response.text()}`);
    }

    const token = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
        scope?: string;
        token_type?: string;
    };
    if (!token.access_token) throw new Error('Token exchange returned no access_token.');

    await writeStore({
        url: MCP_URL,
        access_token: token.access_token,
        token_type: token.token_type,
        scope: token.scope,
        expires_in: token.expires_in,
        // The server sends a lifetime, not a deadline. Storing when it started is the only way
        // anything reading this file can tell whether it is still good.
        obtained_at: Date.now(),
    });

    return { expiresIn: token.expires_in };
}
