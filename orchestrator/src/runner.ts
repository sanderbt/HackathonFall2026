import { spawn } from 'node:child_process';
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { feedAgentLine, type TurnResult } from './agent-events.ts';
import type { EventBus } from './bus.ts';
import type { VerifyStep } from './protocol.ts';

/**
 * Where `run.mjs` lives on this machine.
 *
 * Node resolves a bare specifier like `@anthropic-ai/claude-agent-sdk` by walking up from the
 * SCRIPT's own directory through parent `node_modules` folders — not from the process's cwd — so
 * spawning this absolute path finds the SDK in `orchestrator/node_modules` regardless of which
 * plugin directory the process is working in.
 */
const AGENT_SCRIPT = fileURLToPath(new URL('./sandbox-agent/run.mjs', import.meta.url));

/**
 * Where the demo plugin lives and how it is reset between sessions.
 *
 * The plugin id is reserved once, by hand, and reused forever: ids are global, permanent and
 * digit-free, and `create` reserves one *before* it validates its other arguments, so even a failed
 * create burns a name a real customer plugin might have wanted. Nothing here ever calls `create`.
 */
export type PluginTarget = {
    dir: string;
    pluginId: string;
};

export type VerifyResult = { step: VerifyStep; ok: boolean; output: string };

/**
 * The seam between "what a session does" and "where it runs".
 *
 * `LocalRunner` runs everything as child processes on this machine. `VercelRunner` will run the
 * same steps inside a Vercel Sandbox. The server, the event contract and the chat view are
 * identical either way, which is what lets the cloud path be swapped in without touching them.
 */
export interface Runner {
    reset(): Promise<void>;
    startDev(bus: EventBus): Promise<void>;
    /** Runs one turn of `run.mjs` — locally or in a sandbox — and streams its output onto `bus`. */
    runTurn(
        bus: EventBus,
        prompt: string,
        resume: string | undefined,
        model: string | undefined,
        effort: string | undefined,
    ): Promise<TurnResult>;
    verify(bus: EventBus): Promise<VerifyResult[]>;
    dispose(): Promise<void>;
}

/**
 * Windows needs a shell for `unimicro` and `npm`.
 *
 * Both are installed as `.cmd` shims, and since the fix for CVE-2024-27980 Node refuses to spawn a
 * batch file unless a shell is asked for — reported as a bare `spawn unimicro ENOENT`, which reads
 * like a missing install rather than a platform rule. Every argv reaching these two is a literal, so
 * the escaping `shell: true` gives up buys nothing: the one piece of user prose in this file already
 * travels as a temp FILE for exactly that reason. `node` is a real executable and stays unshelled.
 */
const WIN = process.platform === 'win32';

/** The four gates, in the only order that works. */
const VERIFY_STEPS: ReadonlyArray<readonly [VerifyStep, string, string[]]> = [
    ['check', 'npm', ['run', 'check']],
    ['test', 'npm', ['test']],
    ['build', 'npm', ['run', 'build']],
    // Must follow build: with no dist/, validate reports entryFileMissing and nothing else.
    ['validate', 'unimicro', ['plugin', 'validate', '--json']],
];

function run(
    cmd: string,
    args: string[],
    cwd: string,
): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, env: process.env, shell: WIN });
        let output = '';

        const collect = (chunk: Buffer) => {
            output += chunk.toString();
            // Keep only the tail. A failing build can print megabytes, and all anyone reads is the end.
            if (output.length > 20_000) output = output.slice(-20_000);
        };

        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', (error) => resolve({ code: -1, output: String(error) }));
        child.on('close', (code) => resolve({ code: code ?? -1, output }));
    });
}

export class LocalRunner implements Runner {
    private dev: ReturnType<typeof spawn> | null = null;
    private readonly baseline: string;

    constructor(private readonly target: PluginTarget) {
        this.baseline = join(target.dir, '.baseline');
    }

    /**
     * Put the demo plugin back to its pristine scaffold.
     *
     * A copy rather than `git checkout` on purpose: the demo plugin is one directory inside a larger
     * repo, and this must work whether or not it has been committed.
     */
    async reset(): Promise<void> {
        const src = join(this.target.dir, 'src');
        const saved = join(this.baseline, 'src');

        if (!(await exists(saved))) {
            await mkdir(this.baseline, { recursive: true });
            await cp(src, saved, { recursive: true });
            return; // First run: the current tree *is* the baseline.
        }

        await rm(src, { recursive: true, force: true });
        await cp(saved, src, { recursive: true });
    }

    /**
     * Start the dev loop and resolve once the tunnel is up.
     *
     * `--json` puts one NDJSON event per line on stdout and leaves human and build output on stderr.
     * Note what is deliberately *not* here: any wait on `build.succeeded`. This project runs proxy
     * dev mode, where `verdicts` is false and a build verdict never arrives at all — waiting on one
     * hangs forever and looks like a network fault. Build outcomes come from `verify()`.
     */
    startDev(bus: EventBus): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(
                'unimicro',
                ['plugin', 'dev', '--json', '--no-open', '--no-input'],
                { cwd: this.target.dir, env: process.env, shell: WIN },
            );
            this.dev = child;

            let settled = false;
            let buffer = '';

            child.stdout.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line.trim()) continue;

                    let event: { event?: string; [k: string]: unknown };
                    try {
                        event = JSON.parse(line);
                    } catch {
                        continue; // Not every line is ours to understand.
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
            });

            // The CLI's own diagnostics. Worth surfacing: a dead session fails here, naming
            // `unimicro login`, and that reads as a generic crash if nobody is listening.
            child.stderr.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                if (/sign|login|unauthor/i.test(text)) {
                    bus.emit({ type: 'error', message: text.trim().slice(0, 400), fatal: false });
                }
            });

            child.on('error', (error) => !settled && ((settled = true), reject(error)));
            child.on('close', (code) => {
                if (!settled) {
                    settled = true;
                    reject(new Error(`unimicro plugin dev exited with ${code} before the tunnel came up`));
                }
            });
        });
    }

    /**
     * Runs `run.mjs` as a plain child process, cwd'd at the plugin directory.
     *
     * The prompt goes to a temp FILE, not an argv string — user prose through a shell argument is a
     * quoting accident waiting to happen, and this is the same mechanism VercelRunner uses, just
     * without a sandbox in the way.
     */
    async runTurn(
        bus: EventBus,
        prompt: string,
        resume: string | undefined,
        model: string | undefined,
        effort: string | undefined,
    ): Promise<TurnResult> {
        const promptFile = join(tmpdir(), `factory-turn-${randomUUID()}.txt`);
        await writeFile(promptFile, prompt, 'utf8');

        try {
            return await new Promise<TurnResult>((resolve, reject) => {
                const args = ['--prompt-file', promptFile, '--cwd', this.target.dir];
                if (resume) args.push('--resume', resume);
                if (model) args.push('--model', model);
                if (effort) args.push('--effort', effort);

                const child = spawn('node', [AGENT_SCRIPT, ...args], { env: process.env });
                let result: TurnResult = { sessionId: resume };
                let buffer = '';

                child.stdout.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';
                    for (const line of lines) feedAgentLine(bus, line, (r) => (result = r));
                });

                child.stderr.on('data', (chunk: Buffer) => {
                    bus.emit({ type: 'error', message: chunk.toString().slice(0, 2000), fatal: false });
                });

                child.on('error', reject);
                child.on('close', () => resolve(result));
            });
        } finally {
            await rm(promptFile, { force: true });
        }
    }

    async verify(bus: EventBus): Promise<VerifyResult[]> {
        const results: VerifyResult[] = [];

        for (const [step, cmd, args] of VERIFY_STEPS) {
            const { code, output } = await run(cmd, args, this.target.dir);
            const ok = code === 0;

            results.push({ step, ok, output });
            bus.emit({ type: 'verify.step', step, ok, output: ok ? undefined : output.slice(-4000) });

            if (!ok) break; // No point building code that does not type-check.
        }

        return results;
    }

    /**
     * Stop the dev loop — and on Windows, stop what it actually spawned.
     *
     * `shell: WIN` above means the child is `cmd.exe`, and killing a shell on Windows does not take
     * its children with it: there are no process groups and no signals, so `kill('SIGTERM')` closes
     * the shell and leaves `unimicro plugin dev` holding the dev port and the tunnel. Nothing
     * complains at the time; the next session's `startDev` fails on a port already in use, one
     * layer away from the cause. `taskkill /T` walks the tree, `/F` because a live tunnel does not
     * exit on request.
     */
    async dispose(): Promise<void> {
        const child = this.dev;
        this.dev = null;
        if (!child) return;

        if (WIN && child.pid !== undefined) {
            await new Promise<void>((done) => {
                const kill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                    stdio: 'ignore',
                });
                kill.on('error', () => done());
                kill.on('close', () => done());
            });
            return;
        }

        child.kill('SIGTERM');
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}
