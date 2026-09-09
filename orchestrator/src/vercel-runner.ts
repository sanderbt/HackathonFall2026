import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Sandbox, type Command } from '@vercel/sandbox';
import { feedAgentLine, type TurnResult } from './agent-events.ts';
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
 * laptop. Here the whole toolchain, tunnel and agent both, runs in one box.
 *
 * Provisioning uploads the current working tree rather than cloning a git remote: it needs no
 * GitHub token, no push, and always reflects whatever is on disk right now — including anything
 * not yet committed. The tradeoff is that nothing here is reproducible from a URL alone; that's the
 * right tradeoff for a single-operator prototype and the wrong one the moment a second person needs
 * to point this at the same plugin.
 */

/** Hobby caps a session at 45 minutes; Pro allows 24 hours. The SDK default is 5 MINUTES. */
const SESSION_MS = Number(process.env.FACTORY_SANDBOX_MS ?? 45 * 60 * 1000);

/** Where the plugin and the agent script live inside the sandbox. */
const PLUGIN_DIR = '/vercel/sandbox/plugin';
const AGENT_DIR = '/vercel/sandbox/agent';

const VERIFY_STEPS: ReadonlyArray<readonly [VerifyStep, string, string[]]> = [
    ['check', 'npm', ['run', 'check']],
    ['test', 'npm', ['test']],
    ['build', 'npm', ['run', 'build']],
    // Must follow build: with no dist/, validate reports entryFileMissing and nothing else.
    ['validate', 'unimicro', ['plugin', 'validate', '--json']],
];

const SANDBOX_AGENT_DIR = fileURLToPath(new URL('./sandbox-agent', import.meta.url));

/**
 * The CLI's session file, as the CLI itself stores it (Go's os.UserConfigDir).
 *
 * This is the only way to give the CLI a session in a sandbox: `unimicro login` needs a browser on
 * a loopback redirect, device code is disabled on the current registration, and there is no
 * client-credentials grant. There is also no token flag — `--api-url`, `--issuer` and `--client-id`
 * exist only on a CLI built from source.
 *
 * All three branches mirror `os.UserConfigDir` exactly, because the point is to read what the CLI
 * wrote. Note that Windows is `%AppData%` — Roaming, not Local — and that Go does *not* consult
 * `XDG_CONFIG_HOME` there, so neither does this. Getting that branch wrong fails as a raw ENOENT on
 * a path nobody has ever had, which reads like the machine was never signed in.
 */
function hostConfigPath(): string {
    if (platform() === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', 'unimicro', 'config.json');
    }

    if (platform() === 'win32') {
        const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
        return join(appData, 'unimicro', 'config.json');
    }

    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'unimicro', 'config.json');
}

/**
 * Read the developer's session, keeping only the lane we actually use.
 *
 * Re-read on every provision rather than cached, so the freshest tokens the host CLI has refreshed
 * are the ones that go in. Note the hazard this does not solve: if the issuer rotates refresh
 * tokens, a sandbox refreshing invalidates the host's copy and logs the laptop out too. Run one
 * sandbox at a time.
 */
async function readSession(lane = 'test'): Promise<string> {
    const path = hostConfigPath();

    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch {
        // Naming the path matters: the interesting failure is not "no session" but "looked in the
        // wrong place for this OS", and only the path distinguishes them.
        throw new Error(`No Unimicro CLI session file at ${path}. Run \`unimicro login\`.`);
    }

    const raw = JSON.parse(text);
    const session = raw?.sessions?.[lane];

    if (!session?.tokens?.accessToken) {
        throw new Error(`No ${lane}-lane Unimicro session on this machine. Run \`unimicro login\`.`);
    }

    return JSON.stringify({ sessions: { [lane]: session } });
}

/**
 * Tar the plugin's working tree, excluding what a sandbox neither needs nor should get: installed
 * dependencies (reinstalled fresh — cross-platform node_modules do not travel), build output, git
 * history, and `.unimicro/state.json` (a stale tunnel id and PIDs from this machine).
 *
 * Two details here are Windows rules that cost nothing elsewhere, and both fail as a bare
 * `tar exited 2` during provisioning, which reads like a broken sandbox rather than a path bug:
 *
 *   - The member is `basename(dir)`, not a path. A member given as an absolute Windows path has its
 *     drive stripped by GNU tar ("Removing leading `C:\'") and is then not found at all.
 *   - The archive streams over stdout instead of via a temp file. GNU tar reads any `-f` argument
 *     containing a colon as `host:path` and tries to reach a remote tape drive, so a perfectly
 *     ordinary `C:\Users\…\factory-plugin-*.tar.gz` dies with "Cannot connect to C:". Which `tar`
 *     is on PATH decides whether that bites — Windows ships bsdtar in System32, but Git for Windows
 *     ships GNU tar and a shell that puts it first — so do not rely on getting the forgiving one.
 *     Streaming has no filename to misparse and never touches disk.
 */
async function tarPlugin(dir: string): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
        const tar = spawn(
            'tar',
            [
                '-czf',
                '-',
                '--exclude=node_modules',
                '--exclude=dist',
                '--exclude=.git',
                '--exclude=.unimicro/state.json',
                // AppleDouble sidecars (._foo, carrying macOS extended attributes) are invisible in
                // Finder but real files on disk. Untarred inside the sandbox, `._index.test.tsx`
                // is a file vitest's glob matches — a phantom test suite that fails on nothing the
                // agent wrote. COPYFILE_DISABLE is the documented way to stop tar writing them; it
                // is a no-op, not an error, on a host that already has no such thing.
                '--exclude=._*',
                '-C',
                dirname(dir),
                basename(dir),
            ],
            { env: { ...process.env, COPYFILE_DISABLE: '1' } },
        );

        const chunks: Buffer[] = [];
        let stderr = '';

        tar.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        tar.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        tar.on('error', reject);
        tar.on('close', (code) => {
            if (code === 0) return resolve(Buffer.concat(chunks));
            reject(new Error(`tar exited ${code}: ${stderr.trim().slice(-500)}`));
        });
    });
}

export class VercelRunner implements Runner {
    private sandbox: Sandbox | null = null;
    private devCmd: Command | null = null;

    constructor(private readonly target: PluginTarget) {}

    /**
     * Create the sandbox and put the plugin, the CLI, the agent script and the developer's session
     * in it. Named `reset()` to keep the same shape as LocalRunner: the server calls reset() then
     * startDev() either way, never knowing which Runner it got.
     */
    async reset(): Promise<void> {
        await this.dispose();

        this.sandbox = await Sandbox.create({
            // Ubuntu with Node LTS and full root. x64 — @unimicro/cli ships a linux-x64 binary.
            image: 'vercel/sandbox/universal',
            resources: { vcpus: 2 },
            // Without this the sandbox dies after five minutes and it looks like a flaky network.
            timeout: SESSION_MS,
            // The default. Stated so nobody "tightens" it without reading the note above.
            networkPolicy: 'allow-all',
            // The access-token path has to be passed explicitly: setting VERCEL_TOKEN alone falls
            // through to OIDC and fails asking for `vercel link`. Omitting these keeps the OIDC
            // path (VERCEL_OIDC_TOKEN from `vercel env pull`) working unchanged.
            ...(process.env.VERCEL_TOKEN
                ? {
                      token: process.env.VERCEL_TOKEN,
                      teamId: process.env.VERCEL_TEAM_ID,
                      projectId: process.env.VERCEL_PROJECT_ID,
                  }
                : {}),
        });

        const sandbox = this.sandbox;

        const install = await sandbox.runCommand({
            cmd: 'npm',
            args: ['install', '-g', '@unimicro/cli'],
            sudo: true,
        });
        if (install.exitCode !== 0) throw new Error(await install.stderr());

        // The plugin's working tree, exactly as it sits on this machine right now.
        const pluginTar = await tarPlugin(this.target.dir);
        await sandbox.runCommand({ cmd: 'mkdir', args: ['-p', PLUGIN_DIR] });
        await sandbox.writeFiles([{ path: '/vercel/sandbox/plugin.tar.gz', content: pluginTar }]);
        const untar = await sandbox.runCommand({
            cmd: 'tar',
            args: ['xzf', '/vercel/sandbox/plugin.tar.gz', '-C', PLUGIN_DIR, '--strip-components=1'],
        });
        if (untar.exitCode !== 0) throw new Error(await untar.stderr());

        // The home directory is not guaranteed to be /root, and the CLI resolves its config path
        // from it, so ask rather than assume.
        const whoami = await sandbox.runCommand({ cmd: 'sh', args: ['-c', 'echo $HOME'] });
        const homePath = (await whoami.stdout()).trim() || '/root';

        await sandbox.runCommand({ cmd: 'mkdir', args: ['-p', `${homePath}/.config/unimicro`] });
        await sandbox.writeFiles([
            {
                path: `${homePath}/.config/unimicro/config.json`,
                content: Buffer.from(await readSession()),
                mode: 0o600,
            },
        ]);

        const deps = await sandbox.runCommand({ cmd: 'npm', args: ['ci'], cwd: PLUGIN_DIR });
        if (deps.exitCode !== 0) throw new Error(await deps.stderr());

        // The agent runner script, in a folder of its own — kept separate from the plugin's own
        // package.json so the harness's tooling never pollutes the plugin's dependency graph.
        await sandbox.runCommand({ cmd: 'mkdir', args: ['-p', AGENT_DIR] });
        for (const file of ['package.json', 'run.mjs']) {
            await sandbox.writeFiles([
                {
                    path: `${AGENT_DIR}/${file}`,
                    content: await readFile(`${SANDBOX_AGENT_DIR}/${file}`),
                },
            ]);
        }
        const agentDeps = await sandbox.runCommand({ cmd: 'npm', args: ['install'], cwd: AGENT_DIR });
        if (agentDeps.exitCode !== 0) throw new Error(await agentDeps.stderr());
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
                    cwd: PLUGIN_DIR,
                    detached: true,
                });
                this.devCmd = dev;

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

    /**
     * Runs the identical `run.mjs` that LocalRunner runs, uploaded into the sandbox instead of
     * spawned on this machine. The prompt goes in as a file for the same reason it does locally —
     * user prose through a shell argument is a quoting accident waiting to happen.
     */
    async runTurn(bus: EventBus, prompt: string, resume: string | undefined): Promise<TurnResult> {
        const sandbox = this.sandbox;
        if (!sandbox) throw new Error('reset() must run before runTurn()');

        const promptPath = `/vercel/sandbox/turn-${randomUUID()}.txt`;
        await sandbox.writeFiles([{ path: promptPath, content: Buffer.from(prompt, 'utf8') }]);

        const args = ['run.mjs', '--prompt-file', promptPath, '--cwd', PLUGIN_DIR];
        if (resume) args.push('--resume', resume);

        const turn = await sandbox.runCommand({
            cmd: 'node',
            args,
            cwd: AGENT_DIR,
            env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' },
            detached: true,
        });

        let result: TurnResult = { sessionId: resume };
        let buffer = '';

        for await (const log of turn.logs()) {
            if (log.stream === 'stderr' && log.data.trim()) {
                bus.emit({ type: 'error', message: log.data.slice(0, 2000), fatal: false });
                continue;
            }
            buffer += log.data;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) feedAgentLine(bus, line, (r) => (result = r));
        }

        return result;
    }

    async verify(bus: EventBus): Promise<VerifyResult[]> {
        const sandbox = this.sandbox;
        if (!sandbox) throw new Error('reset() must run before verify()');

        const results: VerifyResult[] = [];

        for (const [step, cmd, args] of VERIFY_STEPS) {
            // detached: false pins the blocking overload — without it TS widens to the union with
            // the detached Command type, whose exitCode is nullable until you wait() on it.
            const finished = await sandbox.runCommand({ cmd, args, cwd: PLUGIN_DIR, detached: false });
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
        this.devCmd = null;
        await this.sandbox?.stop().catch(() => {});
        this.sandbox = null;
    }
}
