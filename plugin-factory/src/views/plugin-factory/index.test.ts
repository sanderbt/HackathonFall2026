import { beforeAll, expect, it } from 'vitest';
import View from './index';
import type { HostError, UnimicroHost } from '@unimicro/plugin-types';

/**
 * The example this project's tests grow from.
 *
 * A view is a custom element, so a test defines it, hands it a host, and reads the DOM it renders —
 * no platform, no tunnel, no company with the right data in it. Everything the view asks the platform
 * for arrives through `host`, so a stub of the parts a test cares about is the whole fixture.
 */
beforeAll(() => {
    // The name is this test's own: the platform picks the tag it mounts under, and defining the same
    // class twice under one name throws.
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
            plugin: { id: 'plugin-factory', version: '0.1.0' },
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
 * Two waits, and both are needed. The first update is the render that happens before
 * connectedCallback's `await` comes back, so it has no company in it yet; letting the microtask
 * queue drain runs the rest of connectedCallback, and the second wait is the render its assignment
 * schedules. Asserting after the first one reads the empty view.
 */
async function settle(view: View) {
    await view.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;
}

it('shows the company it is running in', async () => {
    const view = document.createElement('test-view') as View;
    view.host = stubHost('Acme Freight AS');

    document.body.append(view);
    await settle(view);

    expect(view.shadowRoot?.textContent).toContain('Acme Freight AS');
});

it('says so when the platform refuses', async () => {
    const view = document.createElement('test-view') as View;
    view.host = failingHost();

    document.body.append(view);
    await settle(view);

    // The point of this one is that the view neither throws nor sits there implying the data is
    // still on its way. What it says is yours to change; that it says something is the contract.
    expect(view.shadowRoot?.textContent).toContain('Could not read which company this is running in.');
});
