import { beforeAll, expect, it } from 'vitest';
import { act } from 'react';
import View from './index';
import type { HostError, UnimicroHost } from '@unimicro/plugin-types';

/**
 * The example this project's tests grow from.
 *
 * A view is a custom element, so a test defines it, hands it a host, and reads the DOM it renders —
 * no platform, no tunnel, no company with the right data in it. Everything the view asks the
 * platform for arrives through `host`, so a stub of the parts a test cares about is the whole
 * fixture.
 */
beforeAll(() => {
    // Tells React this is a test environment, so act() flushes effects instead of warning.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    // The name is this test's own: the platform picks the tag it mounts under, and defining the
    // same class twice under one name throws.
    customElements.define('test-view', View);
});

/**
 * The parts of the handle this view reaches for.
 *
 * `Pick` from the real interface is what makes the stubs below typed rather than merely shaped: a
 * getContext declared here has to return a whole HostContext, so a platform type that gains a field,
 * or a stub that gets one wrong, fails to compile instead of passing a test that proves nothing.
 * Widening to UnimicroHost at the end is the honest part — this is a partial handle, and the view
 * only ever touches the part that is filled in. `as unknown as UnimicroHost` is the version to
 * avoid: `unknown` is assignable to anything, so it accepts any object at all and checks nothing.
 */
type StubHost = Pick<UnimicroHost, 'getContext' | 'log'>;

/** Logging is not what these tests are about, but the view uses it, so it has to be there. */
const silentLog: StubHost['log'] = { info: () => {}, warn: () => {}, error: () => {} };

function stubHost(companyName: string): UnimicroHost {
    const host: StubHost = {
        getContext: async () => ({
            plugin: { id: '__PROJECT_ID__', version: '0.1.0' },
            user: { name: 'Ada Lovelace', email: 'ada@example.com' },
            company: { name: companyName, orgNumber: '999888777', key: 'demo' },
        }),
        log: silentLog,
    };

    return host as UnimicroHost;
}

/** A host that refuses the way the platform does: a rejection carrying a code, not a bare Error. */
function failingHost(): UnimicroHost {
    const refusal: HostError = Object.assign(new Error('the platform said no'), {
        code: 'host/request-failed' as const,
        status: 503,
    });

    const host: StubHost = {
        getContext: async () => {
            throw refusal;
        },
        log: silentLog,
    };

    return host as UnimicroHost;
}

/**
 * act() wraps the whole mount, so React's first render, its effects and the promise those effects
 * awaited have all settled by the time it returns. Asserting without it reads the empty view.
 */
async function mount(host: UnimicroHost) {
    const view = document.createElement('test-view') as HTMLElement & { host: UnimicroHost };
    view.host = host;

    await act(async () => {
        document.body.append(view);
    });

    return view;
}

it('shows the company it is running in', async () => {
    const view = await mount(stubHost('Acme Freight AS'));

    expect(view.shadowRoot?.textContent).toContain('Acme Freight AS');
});

it('says so when the platform refuses', async () => {
    const view = await mount(failingHost());

    // The point of this one is that the view neither throws nor sits there implying the data is
    // still on its way. What it says is yours to change; that it says something is the contract.
    expect(view.shadowRoot?.textContent).toContain(
        'Could not read which company this is running in.',
    );
});

it('keeps its state when it is moved in the DOM', async () => {
    const view = await mount(stubHost('Acme Freight AS'));

    // An element moved in the DOM disconnects and reconnects on the same live handle. A view that
    // rebuilt its React root here would come back blank and re-run every effect. This test is what
    // stops someone "simplifying" the queueMicrotask/isConnected dance in react-view.ts.
    const elsewhere = document.createElement('div');
    document.body.append(elsewhere);

    await act(async () => {
        elsewhere.append(view);
    });

    expect(view.shadowRoot?.textContent).toContain('Acme Freight AS');
});
