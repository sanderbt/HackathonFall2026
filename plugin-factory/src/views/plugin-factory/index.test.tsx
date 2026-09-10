import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act } from 'react';
import View from './index';
import type { UnimicroHost } from '@unimicro/plugin-types';
// The one import from the view's own code. Seeding what a reload would have left behind is better
// done through the function that writes it than by hardcoding its storage key in a test.
import { remember } from '#lib/orchestrator';

/**
 * A view is a custom element, so a test defines it, hands it a host, and reads the DOM it renders —
 * no platform, no tunnel, no orchestrator. Everything the view needs from the platform arrives
 * through `host`; everything it needs from the backend arrives over `fetch` and `EventSource`, so
 * both are stubbed here.
 */
beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    customElements.define('test-view', View);
});

/**
 * The parts of the handle this view reaches for.
 *
 * `Pick` from the real interface is what makes these stubs typed rather than merely shaped: a
 * platform type that gains a field fails to compile instead of passing a test that proves nothing.
 * `as unknown as UnimicroHost` is the version to avoid — it accepts any object and checks nothing.
 */
type StubHost = Pick<UnimicroHost, 'log' | 'notifications' | 'navigation'>;

function stubHost(): UnimicroHost {
    const host: StubHost = {
        log: { info: () => {}, warn: () => {}, error: () => {} },
        notifications: { success: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        navigation: {
            navigateTo: async () => {},
            openExternal: async () => {},
            getRoute: async () => '',
        },
    };
    return host as UnimicroHost;
}

/** Records the instances so a test can push events at the view the way the server would. */
class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;

    constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
    }

    close() {
        this.closed = true;
    }

    emit(payload: unknown) {
        this.onmessage?.({ data: JSON.stringify(payload) });
    }
}

/**
 * The orchestrator, as far as the view can tell.
 *
 * Routed by URL rather than answering everything identically, because the view now asks two
 * different questions — is there a session to pick back up, and if not give me a new one — and a
 * stub that cannot tell them apart cannot exercise either.
 */
function install({
    sessionOk = true,
    snapshot = null,
    mcp = { connected: false, url: 'https://test-mcp.unimicro.app/mcp', expiresAt: null, expired: false },
}: { sessionOk?: boolean; snapshot?: unknown; mcp?: unknown } = {}) {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);

    const calls: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
            calls.push(String(url));
            // Answered before the sessionOk switch: whether the company's data is connected is a
            // different question from whether a session can be created, and a test for one should
            // not have to care about the other.
            if (/\/api\/mcp$/.test(String(url))) {
                return { ok: true, status: 200, json: async () => mcp } as Response;
            }
            if (!sessionOk) return { ok: false, status: 500, json: async () => ({}) } as Response;
            if (/\/api\/sessions\/[^/]+$/.test(String(url))) {
                return snapshot
                    ? ({ ok: true, status: 200, json: async () => snapshot } as Response)
                    : ({ ok: false, status: 404, json: async () => ({}) } as Response);
            }
            return { ok: true, status: 201, json: async () => ({ sessionId: 's1' }) } as Response;
        }),
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
    // The view remembers its session across a reload, which means across a test too. Left in
    // place, the next mount resumes the last test's session instead of starting clean.
    sessionStorage.clear();
});

async function mount() {
    const view = document.createElement('test-view') as HTMLElement & { host: UnimicroHost };
    view.host = stubHost();

    await act(async () => {
        document.body.append(view);
    });

    return view;
}

it('offers a way in before anything has happened', async () => {
    install();
    const view = await mount();

    expect(view.shadowRoot?.textContent).toContain('Hva skal pluginen din gjøre?');
    // The examples are the way in for someone who does not know what to type, so an intro that
    // renders without them is not offering a way in.
    expect(view.shadowRoot?.textContent).toContain('List mine ti største ubetalte kundefakturaer');
    // And nothing else. A first visit offers one thing to do; a link to a plugin that does not
    // exist yet, inert or not, is a second thing to read and a dead end to click.
    expect(view.shadowRoot?.textContent).not.toContain('Åpne pluginen din');
});

it('offers one click to connect the company data', async () => {
    install();
    const view = await mount();

    // Asserted on the body copy and the button, not the alert's `header`: that is an attribute on
    // the design-system element, and an unupgraded custom element in jsdom renders none of it.
    expect(view.shadowRoot?.textContent).toContain('bekrefte at en side spør om riktig ting');
    expect(view.shadowRoot?.textContent).toContain('Koble til');
});

it('says nothing about the company data once it is connected', async () => {
    install({
        mcp: {
            connected: true,
            url: 'https://test-mcp.unimicro.app/mcp',
            expiresAt: Date.now() + 3_600_000,
            expired: false,
        },
    });
    const view = await mount();

    // A permanent "connected" badge is clutter on the one screen whose job is to keep a single
    // question in view. Connected means there is nothing to say.
    expect(view.shadowRoot?.textContent).not.toContain('bekrefte at en side spør om riktig ting');
    expect(view.shadowRoot?.textContent).not.toContain('Tilkoblingen har utløpt');
});

it('asks for a reconnect rather than a first connect when the token has aged out', async () => {
    install({
        mcp: {
            connected: false,
            url: 'https://test-mcp.unimicro.app/mcp',
            expiresAt: Date.now() - 1000,
            expired: true,
        },
    });
    const view = await mount();

    // Different words for a different situation: one has never been connected, the other was and
    // needs a click to carry on.
    expect(view.shadowRoot?.textContent).toContain('Tilkoblingen har utløpt');
    expect(view.shadowRoot?.textContent).not.toContain('bekrefte at en side spør om riktig ting');
});

it('does not offer the plugin before the tunnel serves one', async () => {
    install();
    const view = await mount();

    await act(async () => {
        FakeEventSource.instances[0].emit({
            seq: 1,
            type: 'preview.ready',
            url: 'https://test.unimicro.no/#/plugins/sales/factory-demo-alfa/main?tunnelId=t_x',
            tunnelId: 't_x',
            companyKey: 'k',
        });
    });

    // The URL goes live with the tunnel, well before the first turn lands — and what it serves
    // until then is the empty template the session was provisioned from. Having a URL is not the
    // same as having a plugin.
    expect(view.shadowRoot?.textContent).not.toContain('Åpne pluginen din');
});

it('says so when the orchestrator is not answering', async () => {
    install({ sessionOk: false });
    const view = await mount();

    // The point is that it neither throws nor sits there implying something is still loading, and
    // that it names the address — which turns "it's broken" into "oh, the backend moved".
    //
    // Asserted on the alert's body, not its `header`: the platform registers <uni-*> at runtime but
    // nothing registers them here, so an unknown element's attributes never become text. Anything
    // passed to a design-system component as an attribute is invisible to a test.
    expect(view.shadowRoot?.textContent).toContain('Ingenting svarer på');
});

it('closes the stream when the view goes away', async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    await act(async () => {
        view.remove();
    });

    // Nothing else closes this. An EventSource left open keeps reconnecting inside the platform's
    // own page for the life of the tab.
    expect(source.closed).toBe(true);
});

/** What the waiting person reads. The stage is the only part of the view that speaks to them. */
function stage(view: HTMLElement): string {
    return view.shadowRoot?.querySelector('.stage')?.textContent ?? '';
}

it("keeps the agent's own narration off the screen while it works", async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    await act(async () => {
        source.emit({ seq: 1, type: 'session.state', state: 'working' });
        source.emit({ seq: 2, type: 'agent.skill', skill: 'platform-api' });
        source.emit({ seq: 3, type: 'agent.tool', name: 'Edit', summary: 'src/views/main/App.tsx' });
        source.emit({ seq: 4, type: 'verify.step', step: 'build', ok: true });
    });

    // The events still arrive and still drive the indicator — they are simply not the content.
    // They stay reachable behind "Tekniske detaljer", which is why this asserts on the stage
    // rather than on the whole view.
    expect(stage(view)).not.toContain('platform-api');
    expect(stage(view)).not.toContain('src/views/main/App.tsx');
    expect(stage(view)).toContain('Fortsatt i gang');
});

it('moves the waiting message every time the agent shows a sign of life', async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    await act(async () => {
        source.emit({ seq: 1, type: 'session.state', state: 'working' });
    });
    const first = view.shadowRoot?.querySelector('.message')?.textContent;

    await act(async () => {
        source.emit({ seq: 2, type: 'agent.tool', name: 'Write', summary: 'view.css' });
    });

    // Someone who cannot read the tool calls needs other evidence that this is alive, and this is
    // that evidence — so it is worth a test. A message that never moves is a hung factory.
    expect(view.shadowRoot?.querySelector('.message')?.textContent).not.toBe(first);
});

it('says the plugin is ready rather than listing the gates that passed', async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    await act(async () => {
        source.emit({ seq: 1, type: 'agent.text', text: 'Added an overdue invoices page.' });
        source.emit({ seq: 2, type: 'session.state', state: 'updated' });
    });

    expect(stage(view)).toContain('Pluginen din er klar');
    // The closing summary is the one piece of the agent's narration written for the reader.
    expect(stage(view)).toContain('Added an overdue invoices page.');
});

it("reads the agent's closing message back as prose, not as Markdown", async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    // What a turn actually ends with. The agent writes for a terminal, so it writes Markdown.
    const text = [
        'Ferdig! Alle fire gatene har passert.',
        '',
        '## Hva ble laget',
        '',
        '- **Kundenavn** og kundenummer',
        '- **Antall fakturaer** per kunde',
    ].join('\n');

    await act(async () => {
        source.emit({ seq: 1, type: 'agent.text', text });
        source.emit({ seq: 2, type: 'session.state', state: 'updated' });
    });

    // Verbatim, this printed `##` and `**` down the middle of the payoff screen and the line clamp
    // cut it off mid-word. The heading is dropped rather than read out as the summary of what it
    // is a caption for, and the two bullets are separated rather than run into one sentence.
    expect(stage(view)).toContain(
        'Ferdig! Alle fire gatene har passert. Kundenavn og kundenummer; Antall fakturaer per kunde',
    );
    expect(stage(view)).not.toContain('#');
    expect(stage(view)).not.toContain('**');
    // And the message as it was written is still there in full, for whoever wants all of it.
    expect(await openLog(view)).toContain('## Hva ble laget');
});

/** Finds a design-system button by its label, since nothing here registers <uni-button>. */
function button(view: HTMLElement, label: string): Element | undefined {
    return [...(view.shadowRoot?.querySelectorAll('uni-button') ?? [])].find((b) =>
        b.textContent?.includes(label),
    );
}

/**
 * Opens the technical-details panel and returns the log verbatim.
 *
 * The log opens over the stage rather than under the composer: anything with a height of its own
 * down there pushes the field out of a frame that never scrolls.
 */
async function openLog(view: HTMLElement): Promise<string> {
    await act(async () => {
        button(view, 'Tekniske detaljer')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        );
    });
    return view.shadowRoot?.querySelector('.console pre')?.textContent ?? '';
}

it('opens the log over the stage rather than under the composer', async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    await act(async () => {
        source.emit({ seq: 1, type: 'session.state', state: 'working' });
        source.emit({ seq: 2, type: 'agent.tool', name: 'Edit', summary: 'view.css' });
    });

    expect(await openLog(view)).toContain('view.css');
    // Where it opens is the whole point. The composer is the last row of a frame that never
    // scrolls, so a panel with a height of its own down there pushes the field over the edge —
    // which is what a disclosure in the composer did. The stage is the only row that can give up
    // its height, so the log takes that instead and the waiting screen stands down while it is up.
    expect(view.shadowRoot?.querySelector('.stage .console')).not.toBeNull();
    expect(view.shadowRoot?.querySelector('.composer .console')).toBeNull();
    expect(stage(view)).not.toContain('Fortsatt i gang');
});

it('picks a running build back up rather than starting a second one', async () => {
    remember({ id: 's0', request: 'Show my most recent customers', startedAt: Date.now() });
    const calls = install({
        snapshot: {
            sessionId: 's0',
            state: 'working',
            pluginId: 'factory-demo-alfa',
            previewUrl: 'https://test.unimicro.no/#/plugins/sales/x/main?tunnelId=t_y',
            events: [
                { seq: 1, type: 'session.state', state: 'provisioning' },
                { seq: 2, type: 'session.state', state: 'working' },
                { seq: 3, type: 'agent.tool', name: 'Edit', summary: 'App.tsx' },
            ],
        },
    });
    const view = await mount();

    // The whole point: a reload used to abandon the build and commission another one.
    expect(calls.some((url) => url.endsWith('/api/sessions'))).toBe(false);
    // And the stream asks only for the gap, because the history is already on screen.
    expect(FakeEventSource.instances[0].url).toContain('lastEventId=3');
    expect(stage(view)).toContain('Show my most recent customers');
    expect(stage(view)).toContain('Fortsatt i gang');
});

it('starts clean when the remembered session is gone', async () => {
    remember({ id: 'stale', request: null, startedAt: null });
    const calls = install(); // no snapshot: the orchestrator answers 404

    await mount();

    expect(calls.some((url) => url.endsWith('/api/sessions'))).toBe(true);
    expect(FakeEventSource.instances[0].url).not.toContain('lastEventId');
});

it('applies an event once, however many times it arrives', async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    await act(async () => {
        source.emit({ seq: 1, type: 'agent.tool', name: 'Edit', summary: 'view.css' });
        // What a reconnect looks like from here: the orchestrator replays from the last id the
        // browser saw, which overlaps whatever was already applied.
        source.emit({ seq: 1, type: 'agent.tool', name: 'Edit', summary: 'view.css' });
    });

    const lines = (await openLog(view)).split('\n');
    expect(lines.filter((line) => line.includes('view.css'))).toHaveLength(1);
});

it('holds the link to the result back until the build is done', async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    await act(async () => {
        source.emit({ seq: 1, type: 'session.state', state: 'working' });
        source.emit({
            seq: 2,
            type: 'preview.ready',
            url: 'https://test.unimicro.no/#/plugins/sales/x/main?tunnelId=t_z',
            tunnelId: 't_z',
            companyKey: 'k',
        });
    });

    // Nothing to open during the first build. It is not shown-but-inert either: a disabled control
    // with no explanation beside it is a question, and the waiting screen has enough to read.
    expect(button(view, 'Åpne pluginen din')).toBeUndefined();

    await act(async () => {
        source.emit({ seq: 3, type: 'session.state', state: 'updated' });
    });

    expect(button(view, 'Åpne pluginen din')).toBeDefined();
    // ...and it becomes the point of the screen rather than a footnote under the composer.
    expect(view.shadowRoot?.querySelector('.open--ready')).not.toBeNull();
    // The button carries the URL; the URL itself is not beside it. A tunnel address is noise to the
    // person reading this, and `openExternal` is the host doing the opening, not a popup to block.
    // It stays in the log behind "Tekniske detaljer", which is why this asserts on the stage.
    expect(stage(view)).not.toContain('tunnelId=t_z');
});

it('keeps the last built plugin reachable while a change is being built', async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    await act(async () => {
        source.emit({
            seq: 1,
            type: 'preview.ready',
            url: 'https://test.unimicro.no/#/plugins/sales/x/main?tunnelId=t_z',
            tunnelId: 't_z',
            companyKey: 'k',
        });
        source.emit({ seq: 2, type: 'session.state', state: 'updated' });
        source.emit({ seq: 3, type: 'session.state', state: 'working' });
    });

    // A second turn is running, so the screen is a waiting screen again — but the plugin from the
    // turn before is still standing behind that URL, and there is no reason to take away the way
    // to go and look at it. Ranked below the build that is in progress, not hidden.
    expect(stage(view)).toContain('Fortsatt i gang');
    expect(button(view, 'Åpne pluginen din')).toBeDefined();
    expect(view.shadowRoot?.querySelector('.open--ready')).toBeNull();
});

it('marks where the build has got to, and only while it is running', async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    // Idle: no rail at all. Captioned "Build progress" with nothing marked on it, it promised
    // something it could not show — four blank circles read as broken rather than as not started.
    expect(view.shadowRoot?.querySelector('.progress')).toBeNull();

    await act(async () => {
        source.emit({ seq: 1, type: 'session.state', state: 'verifying' });
    });

    const steps = [...(view.shadowRoot?.querySelectorAll('.progress uni-step') ?? [])];
    expect(steps.map((s) => s.getAttribute('name'))).toEqual([
        'Gjør klar',
        'Bygger',
        'Sjekker',
        'Klar',
    ]);
    const marked = (flag: string) =>
        steps.filter((s) => s.hasAttribute(flag)).map((s) => s.getAttribute('name'));

    // The point of a stepper: one step is where we are, everything before it is behind us.
    expect(marked('active')).toEqual(['Sjekker']);
    expect(marked('completed')).toEqual(['Gjør klar', 'Bygger']);
});

it('can be told to try again after the orchestrator was down', async () => {
    install({ sessionOk: false });
    const view = await mount();

    expect(button(view, 'Prøv igjen')).toBeDefined();

    // Nothing retries a session that was never created — EventSource only reconnects a stream it
    // already had — so this button is the only way out of that state short of a reload.
    install();
    await act(async () => {
        button(view, 'Prøv igjen')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(FakeEventSource.instances[0]).toBeDefined();
    expect(view.shadowRoot?.textContent).not.toContain('Ingenting svarer på');
});
