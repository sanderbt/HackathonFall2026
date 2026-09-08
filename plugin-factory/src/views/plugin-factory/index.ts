import { LitElement, html, unsafeCSS } from 'lit';
import type { HostError, UnimicroHost } from '@unimicro/plugin-types';
// The design system's custom elements — <uni-alert>, <uni-button> and the rest — are registered for
// this view either way: by the platform for a native view, by the shell for an isolated one. This
// import is type-only and emits nothing; importing the package for real would add its whole bundle to
// every view and redefine names that are already held.
import type {} from '@unimicro/design-system/components';
// The view carries its own stylesheet, adopted on its own shadow root, the same way in either model.
import styles from './view.css?inline';

/**
 * A rejection from the host, which carries a stable `code` — `host/revoked`, `host/request-failed`
 * and the rest. Branch on that and never on the message: the message is for a human reading a log.
 */
function isHostError(error: unknown): error is HostError {
    return error instanceof Error && 'code' in error;
}

/**
 * A plugin view is a custom element, default-exported from the file the manifest names as its entry.
 * LitElement is one, so this is a plugin view.
 *
 * The platform assigns `host` before the browser connects the element, so it is ready to use from
 * the first line of connectedCallback. Everything the view does beyond rendering itself — reading
 * platform data, navigating, dialogs, logging — goes through it.
 */
export default class PluginFactoryView extends LitElement {
    /** Assigned by the platform before this element is connected. */
    host!: UnimicroHost;

    static properties = {
        companyName: { state: true },
        failure: { state: true },
    };

    static styles = unsafeCSS(styles);

    /** Reactive state, so assigning it re-renders the view. */
    private companyName = '';

    /** What went wrong, when something did. Empty means nothing has. */
    private failure = '';

    async connectedCallback() {
        super.connectedCallback();

        // Every call through the host can reject, and this one is the first thing the view does.
        // Without the catch the rejection is unhandled: it never reaches a user, the view keeps
        // rendering as though the data were merely still coming, and the only trace is a line in a
        // console nobody has open. A view that cannot get its data says so.
        try {
            const context = await this.host.getContext();
            this.companyName = context.company.name;
        } catch (error) {
            // The view was unmounted while the call was in flight — its handle is dead and so is
            // everything it could render into. There is nobody left to tell.
            if (isHostError(error) && error.code === 'host/revoked') {
                return;
            }

            this.failure = 'Could not read which company this is running in.';

            // Attributed to this plugin, and visible to whoever supports it. The user gets the line
            // above; the reason belongs here.
            this.host.log.error(error, { view: 'plugin-factory' });
        }
    }

    render() {
        return html`
            <section>
                <h1>Hello from Hackathon Demo</h1>

                ${this.failure
                    ? html`<uni-alert type="critical">${this.failure}</uni-alert>`
                    : html`<p>Running in ${this.companyName || 'this company'}.</p>`}

                <uni-alert>
                    The design system's components are available here, and the platform's design
                    tokens reach into this view — so it can look like part of the product.
                </uni-alert>
            </section>
        `;
    }
}
