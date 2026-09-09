/**
 * Browser sign-in to the Unimicro MCP server, from a terminal.
 *
 *   npm run mcp-login
 *
 * The button in the plugin view is the normal path and needs no terminal — this exists for the case
 * where the view is not up, or where somebody would rather see the flow happen. Both drive the same
 * code in `mcp-auth.ts`; they differ only in where the browser is sent back to, since this one has
 * to stand up a listener of its own while the server already has a route.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { begin, complete } from './mcp-auth.ts';
import { TOKEN_FILE } from './unimicro-mcp.ts';

/** Its own port, so this works whether or not the orchestrator is running. */
const PORT = Number(process.env.UNIMICRO_MCP_REDIRECT_PORT ?? 7891);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

/** Long enough for a real sign-in, short enough that a forgotten terminal does not hang forever. */
const TIMEOUT_MS = 5 * 60 * 1000;

/** Open the URL in the developer's browser, best-effort. The URL is printed either way. */
function openBrowser(url: string): void {
    const [cmd, args] =
        process.platform === 'darwin'
            ? ['open', [url]]
            : process.platform === 'win32'
              ? ['cmd', ['/c', 'start', '', url]]
              : ['xdg-open', [url]];

    spawn(cmd, args, { stdio: 'ignore', detached: true })
        .on('error', () => {})
        .unref();
}

/** Hold the loopback listener open until the browser comes back with a code. */
function awaitCode(expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', REDIRECT_URI);
            if (url.pathname !== '/callback') {
                response.writeHead(404).end();
                return;
            }

            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');
            const state = url.searchParams.get('state');

            const done = (message: string) => {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                response.end(
                    `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">${message}</body>`,
                );
                server.close();
            };

            if (error) {
                done('Sign-in failed. You can close this tab.');
                reject(new Error(`Authorization failed: ${error}`));
                return;
            }
            // A mismatched state means this is not the response we asked for. Refuse it rather than
            // exchanging a code that arrived from somewhere else.
            if (state !== expectedState) {
                done('Unexpected response. You can close this tab.');
                reject(new Error('State mismatch on the authorization response.'));
                return;
            }
            if (!code) {
                done('No authorization code came back. You can close this tab.');
                reject(new Error('Authorization response carried no code.'));
                return;
            }

            done('Signed in. You can close this tab and go back to the terminal.');
            resolve(code);
        });

        server.on('error', reject);
        server.listen(PORT, '127.0.0.1');

        setTimeout(() => {
            server.close();
            reject(new Error(`No response within ${TIMEOUT_MS / 1000}s. Nothing was saved.`));
        }, TIMEOUT_MS).unref();
    });
}

async function main(): Promise<void> {
    const { url, pending } = await begin(REDIRECT_URI);

    // Printed unconditionally, and to stderr: if the browser does not open — a remote shell, a
    // headless box — this line is the only thing anybody can act on.
    process.stderr.write(`\nSign in to Unimicro MCP:\n  ${url}\n\n`);

    // Listener first, browser second. The other order races: a fast redirect can arrive before
    // anything is listening, and that fails as a connection refused page nobody can retry from.
    const code = awaitCode(pending.state);
    openBrowser(url);

    const { expiresIn } = await complete(await code, pending);

    const hours = expiresIn ? Math.round((expiresIn / 3600) * 10) / 10 : null;
    process.stderr.write(
        `Saved to ${TOKEN_FILE}${hours ? ` — valid for about ${hours}h` : ''}.\n` +
            'The agent will use it on the next turn.\n',
    );
}

main().catch((error) => {
    process.stderr.write(`\nmcp-login failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
});
