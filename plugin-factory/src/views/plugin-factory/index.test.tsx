import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act } from 'react';
import View from './index';
import type { UnimicroHost } from '@unimicro/plugin-types';

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

function install({ sessionOk }: { sessionOk: boolean }) {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
            sessionOk
                ? ({ ok: true, json: async () => ({ sessionId: 's1' }) } as Response)
                : ({ ok: false, status: 500, json: async () => ({}) } as Response),
        ),
    );
}

afterEach(() => vi.unstubAllGlobals());

async function mount() {
    const view = document.createElement('test-view') as HTMLElement & { host: UnimicroHost };
    view.host = stubHost();

    await act(async () => {
        document.body.append(view);
    });

    return view;
}

it('offers a way in before anything has happened', async () => {
    install({ sessionOk: true });
    const view = await mount();

    expect(view.shadowRoot?.textContent).toContain('Describe the functionality you want');
});

it('shows the plugin link once the tunnel is up', async () => {
    install({ sessionOk: true });
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

    expect(view.shadowRoot?.textContent).toContain('Open your plugin');
    // The URL is rendered as selectable text too, because a popup blocker will eat the button.
    expect(view.shadowRoot?.textContent).toContain('tunnelId=t_x');
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
    expect(view.shadowRoot?.textContent).toContain('Nothing is answering at');
});

it('closes the stream when the view goes away', async () => {
    install({ sessionOk: true });
    const view = await mount();
    const source = FakeEventSource.instances[0];

    await act(async () => {
        view.remove();
    });

    // Nothing else closes this. An EventSource left open keeps reconnecting inside the platform's
    // own page for the life of the tab.
    expect(source.closed).toBe(true);
});
