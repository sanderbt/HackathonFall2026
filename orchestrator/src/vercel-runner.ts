import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '@vercel/sandbox';
import type { EventBus } from './bus.ts';
import type { PluginTarget, Runner, VerifyResult } from './runner.ts';
import type { VerifyStep } from './protocol.ts';

/**
 * Runs the same steps as LocalRunner, inside a Vercel Sandbox.
 *
 * Why Vercel rather than Daytona: a sandbox's default network policy is `allow-all` —
 * "unrestricted access to the public Internet" — on every plan including Hobby. Daytona's free
 * tier restricts egress to a DNS/SNI allowlist that does not include developer-api.unimicro.no and
 * cannot be overridden below its $500 tier, which would have forced the tunnel to stay on the
 * laptop. Here the whole toolchain, tunnel included, runs in one box.
 */

/** Hobby caps a session at 45 minutes; Pro allows 24 hours. The SDK default is 5 MINUTES. */
const SESSION_MS = Number(process.env.FACTORY_SANDBOX_MS ?? 45 * 60 * 1000);

/** Where the plugin lives inside the sandbox. */
const WORK = '/vercel/sandbox/plugin';

const VERIFY_STEPS: ReadonlyArray<readonly [VerifyStep, string, string[]]> = [
    ['check', 'npm', ['run', 'check']],
    ['test', 'npm', ['test']],
    ['build', 'npm', ['run', 'build']],
    // Must follow build: with no dist/, validate reports entryFileMissing and nothing else.
    ['validate', 'unimicro', ['plugin', 'validate', '--json']],
];

/**
 * The CLI's session file, as the CLI itself stores it (Go's os.UserConfigDir).
 *
 * This is the only way to give the CLI a session in a sandbox: `unimicro login` needs a browser on
 * a loopback redirect, device code is disabled on the current registration, and there is no
 * client-credentials grant. There is also no token flag — `--api-url`, `--issuer` and `--client-id`
 * exist only on a CLI built from source.
 */
function hostConfigPath(): string {
    return platform() === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'unimicro', 'config.json')
        : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'unimicro', 'config.json');
}

/**
 * Read the developer's session, keeping only the lane we actually use.
 *
 * Re-read before every provision rather than cached at startup, so the freshest tokens the host CLI
 * has refreshed are the ones that go in. Note the hazard this does not solve: if the issuer rotates
 * refresh tokens, a sandbox refreshing invalidates the host's copy and logs the laptop out. Run one
 * sandbox at a time during a demo.
 */
async function readSession(lane = 'test'): Promise<string> {
    const raw = JSON.parse(await readFile(hostConfigPath(), 'utf8'));
    const session = raw?.sessions?.[lane];

    if (!session?.tokens?.accessToken) {
        throw new Error(`No ${lane}-lane Unimicro session on this machine. Run \`unimicro login\`.`);
    }

    return JSON.stringify({ sessions: { [lane]: session } });
}

export class VercelRunner implements Runner {
    private sandbox: Sandbox | null = null;
    private dev: { kill(signal: string): Promise<unknown> } | null = null;

    constructor(
        private readonly target: PluginTarget,
        private readonly repoUrl: string,
        private readonly gitToken: string | undefined,
    ) {}

    /**
     * Create the sandbox and put the plugin, the CLI and the developer's session in it.
     *
     * `reset` rather than a separate provision step so the Runner interface stays the same shape as
     * LocalRunner's: the server calls reset() then startDev() either way.
     */
    async reset(): Promise<void> {
        await this.dispose();

        this.sandbox = await Sandbox.create({
            source: this.gitToken
                ? {
                      type: 'git',
                      url: this.repoUrl,
                      username: 'x-access-token',
                      password: this.gitToken,
                      depth: 1,
                  }
                : { type: 'git', url: this.repoUrl, depth: 1 },
            // Ubuntu with Node LTS and full root. x64 — @unimicro/cli ships a linux-x64 binary.
            image: 'vercel/sandbox/universal',
            resources: { vcpus: 2 },
            // Without this the sandbox dies after five minutes and it looks like a flaky network.
            timeout: SESSION_MS,
            // The default. Stated so nobody "tightens" it without reading the note above.
            networkPolicy: 'allow-all',
            env: {
                ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
                // Guarantees the CLI fails loudly instead of trying to open a browser that is not there.
                UNIMICRO_NO_BROWSER: '1',
            },
        });

        const sandbox = this.sandbox;

        const install = await sandbox.runCommand({
            cmd: 'npm',
            args: ['install', '-g', '@unimicro/cli'],
            sudo: true,
        });
        if (install.exitCode !== 0) throw new Error(await install.stderr());

        // The home directory is not guaranteed to be /root, and the CLI resolves its config path
        // from it, so ask rather than assume.
        const whoami = await sandbox.runCommand({ cmd: 'sh', args: ['-c', 'echo $HOME'] });
        const homePath = (await whoami.stdout()).trim() || '/root';

        await sandbox.mkDir(`${homePath}/.config/unimicro`);
        await sandbox.writeFiles([
            {
                path: `${homePath}/.config/unimicro/config.json`,
                content: Buffer.from(await readSession()),
                mode: 0o600,
            },
        ]);

        const deps = await sandbox.runCommand({ cmd: 'npm', args: ['ci'], cwd: WORK });
        if (deps.exitCode !== 0) throw new Error(await deps.stderr());
    }

    /** Start the dev loop and resolve when the tunnel is up. Same NDJSON contract as locally. */
    startDev(bus: EventBus): Promise<void> {
        const sandbox = this.sandbox;
        if (!sandbox) throw new Error('reset() must run before startDev()');

        return new Promise((resolve, reject) => {
            void (async () => {
                const dev = await sandbox.runCommand({
                    cmd: 'unimicro',
                    args: ['plugin', 'dev', '--json', '--no-open', '--no-input'],
                    cwd: WORK,
                    detached: true,
                });
                this.dev = dev as unknown as { kill(signal: string): Promise<unknown> };

                let settled = false;
                let buffer = '';

                for await (const log of dev.logs()) {
                    if (log.stream !== 'stdout') {
                        // A dead session fails here naming `unimicro login`; surfacing it turns a
                        // mystery crash into an actionable message.
                        if (/sign|login|unauthor/i.test(log.data)) {
                            bus.emit({ type: 'error', message: log.data.slice(0, 400), fatal: false });
                        }
                        continue;
                    }

                    buffer += log.data;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';

                    for (const line of lines) {
                        if (!line.trim()) continue;

                        let event: { event?: string; [k: string]: unknown };
                        try {
                            event = JSON.parse(line);
                        } catch {
                            continue;
                        }

                        bus.emit({ type: 'dev.event', event: String(event.event), data: event });

                        if (event.event === 'tunnel.ready') {
                            bus.emit({
                                type: 'preview.ready',
                                url: String(event.url),
                                tunnelId: String(event.tunnelId),
                                companyKey: String(event.companyKey),
                            });
                            if (!settled) {
                                settled = true;
                                resolve();
                            }
                        }
                    }
                }

                if (!settled) reject(new Error('the dev loop ended before the tunnel came up'));
            })().catch(reject);
        });
    }

    async verify(bus: EventBus): Promise<VerifyResult[]> {
        const sandbox = this.sandbox;
        if (!sandbox) throw new Error('reset() must run before verify()');

        const results: VerifyResult[] = [];

        for (const [step, cmd, args] of VERIFY_STEPS) {
            const finished = await sandbox.runCommand({ cmd, args, cwd: WORK });
            const ok = finished.exitCode === 0;
            const output = ok ? '' : ((await finished.stderr()) || (await finished.stdout())).slice(-4000);

            results.push({ step, ok, output });
            bus.emit({ type: 'verify.step', step, ok, output: ok ? undefined : output });

            if (!ok) break;
        }

        return results;
    }

    /**
     * Stop, do not delete.
     *
     * Sandboxes are persistent by default: stopping snapshots the filesystem, so the next session
     * resumes with node_modules already installed. Stopping promptly also matters for cost —
     * provisioned memory is billed on wall-clock even at 0% CPU, unlike Active CPU which excludes
     * I/O wait.
     */
    async dispose(): Promise<void> {
        await this.dev?.kill('SIGTERM').catch(() => {});
        this.dev = null;
        await this.sandbox?.stop().catch(() => {});
        this.sandbox = null;
    }
}
