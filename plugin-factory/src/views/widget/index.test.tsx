import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act } from 'react';
import View from './index';
import type { UnimicroHost } from '@unimicro/plugin-types';

/**
 * The dashboard tile, rendered against a stubbed host and a stubbed orchestrator — no platform, no
 * tunnel, no backend. What is asserted here is what the tile *says* in each state, because that is
 * the part nobody can check by looking at a dashboard mid-build.
 */
beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    customElements.define('test-widget', View);
});

type StubHost = Pick<UnimicroHost, 'log' | 'notifications' | 'navigation'>;

function stubHost(): UnimicroHost {
    const host: StubHost = {
        log: { info: () => {}, warn: () => {}, error: () => {} },
        notifications: { success: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        navigation: { navigateTo: async () => {}, openExternal: async () => {}, getRoute: async () => '' },
    };
    return host as UnimicroHost;
}

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

function install({ sessionOk = true }: { sessionOk?: boolean } = {}) {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
            sessionOk
                ? ({ ok: true, status: 201, json: async () => ({ sessionId: 's1' }) } as Response)
                : ({ ok: false, status: 500, json: async () => ({}) } as Response),
        ),
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
    // The tile remembers its session across a reload, which means across a test too.
    sessionStorage.clear();
});

async function mount() {
    const view = document.createElement('test-widget') as HTMLElement & { host: UnimicroHost };
    view.host = stubHost();

    await act(async () => {
        document.body.append(view);
    });

    return view;
}

function stage(view: HTMLElement): string {
    return view.shadowRoot?.querySelector('.stage')?.textContent ?? '';
}

/** Finds a design-system button by its label, since nothing here registers <uni-button>. */
function button(view: HTMLElement, label: string): Element | undefined {
    return [...(view.shadowRoot?.querySelectorAll('uni-button') ?? [])].find((b) =>
        b.textContent?.includes(label),
    );
}

it('offers a way in before anything has happened', async () => {
    install();
    const view = await mount();

    expect(stage(view)).toContain('Hva skal pluginen din gjøre?');
    // The prompts are the way in for someone who does not know what to type.
    expect(button(view, 'Tell ordre etter status')).toBeDefined();
    expect(button(view, 'Bygg')).toBeDefined();
});

it('never renders an illustration', async () => {
    install();
    const view = await mount();

    // `<uni-illustration>` builds its own `<img src="${config.assetsPath}/illustrations/…">`, and
    // `assetsPath` is the platform's to set — unset, every name 404s while the element still holds
    // its square aspect ratio, which is a blank hole in the middle of the tile. A view cannot fix
    // that without writing to the platform's own design-system config, so it uses none.
    expect(view.shadowRoot?.querySelector('uni-illustration')).toBeNull();
});

it('marks where the build has got to while it runs', async () => {
    install();
    const view = await mount();

    await act(async () => {
        FakeEventSource.instances[0].emit({ seq: 1, type: 'session.state', state: 'verifying' });
    });

    const steps = [...(view.shadowRoot?.querySelectorAll('.rail uni-step') ?? [])];
    expect(steps.map((s) => s.getAttribute('name'))).toEqual(['Gjør klar', 'Bygger', 'Sjekker', 'Klar']);

    const marked = (flag: string) =>
        steps.filter((s) => s.hasAttribute(flag)).map((s) => s.getAttribute('name'));

    // The point of a stepper: one step is where we are, everything before it is behind us.
    expect(marked('active')).toEqual(['Sjekker']);
    expect(marked('completed')).toEqual(['Gjør klar', 'Bygger']);
});

it('keeps the rail off an idle tile', async () => {
    install();
    const view = await mount();

    // Four blank circles under "what should your plugin do?" promise something they cannot show:
    // with no phase, no step is active, and an unmarked stepper reads as broken rather than idle.
    expect(view.shadowRoot?.querySelector('.rail')).toBeNull();
});

it('moves the waiting line on every sign of life from the agent', async () => {
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

    // Someone who cannot read the tool calls — and this tile shows none — needs other evidence
    // that this is alive. A line that never moves is a hung factory.
    expect(view.shadowRoot?.querySelector('.message')?.textContent).not.toBe(first);
    // ...and the narration itself still never reaches the screen.
    expect(stage(view)).not.toContain('view.css');
});

it("reads the agent's closing message back as prose, not as Markdown", async () => {
    install();
    const view = await mount();
    const source = FakeEventSource.instances[0];

    const text = ['Ferdig! Alle fire gatene har passert.', '', '## Hva ble laget', '', '- **Kundenavn** og nummer'].join(
        '\n',
    );

    await act(async () => {
        source.emit({ seq: 1, type: 'agent.text', text });
        source.emit({ seq: 2, type: 'session.state', state: 'updated' });
    });

    expect(stage(view)).toContain('Pluginen din er klar');
    expect(stage(view)).toContain('Ferdig! Alle fire gatene har passert. Kundenavn og nummer');
    expect(stage(view)).not.toContain('#');
    expect(stage(view)).not.toContain('**');
});

it('holds the link to the result back until there is something behind it', async () => {
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

    // The URL goes live with the tunnel, well before the first turn lands, and what it serves until
    // then is the empty template the session was provisioned from.
    expect(button(view, 'Åpne pluginen din')).toBeUndefined();

    await act(async () => {
        source.emit({ seq: 3, type: 'session.state', state: 'updated' });
    });

    // Inside the state that explains it, and given its own room — not a full-width bar wedged
    // between the stage and the composer, which is what it was.
    expect(view.shadowRoot?.querySelector('.panel--done .open--ready')).not.toBeNull();
    expect(button(view, 'Åpne pluginen din')).toBeDefined();
    expect(stage(view)).not.toContain('tunnelId=t_z');
});

it('says so when the orchestrator is not answering', async () => {
    install({ sessionOk: false });
    const view = await mount();

    expect(view.shadowRoot?.textContent).toContain('Kan ikke nå plugin-fabrikken');
    expect(button(view, 'Prøv igjen')).toBeDefined();
});

it('closes the stream when the tile goes away', async () => {
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
