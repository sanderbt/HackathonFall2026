import { createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UnimicroHost } from '@unimicro/plugin-types';

/** What every view component is handed. The handle is the whole interface to the platform. */
export type ViewProps = { host: UnimicroHost };

/**
 * One CSSStyleSheet per stylesheet text, shared by every element that adopts it, so a view mounted
 * twice parses its CSS once.
 */
const sheets = new Map<string, CSSStyleSheet>();

function adopt(root: ShadowRoot, css: string): void {
    // happy-dom and any engine without constructable stylesheets: a <style> does the same job,
    // just without the sharing. Without this fallback every test renders unstyled.
    if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in root)) {
        const style = document.createElement('style');
        style.textContent = css;
        root.append(style);
        return;
    }

    let sheet = sheets.get(css);
    if (!sheet) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        sheets.set(css, sheet);
    }
    root.adoptedStyleSheets = [sheet];
}

/**
 * A plugin view is a custom element whose default export the platform imports. React is not one, so
 * this wraps a component in the element the contract asks for, and holds the two lifecycle rules
 * that are easy to get wrong:
 *
 *  - An element moved in the DOM disconnects and reconnects on the SAME live handle. A createRoot
 *    per connect leaks a root per move and throws away everything on screen.
 *  - Unmounting is what runs React's effect cleanups, and those are where a view closes the streams,
 *    sockets and timers it opened itself. The platform revokes `host` at unmount and releases the
 *    subscriptions it granted — it knows nothing about an EventSource you opened.
 */
export function createReactView(App: ComponentType<ViewProps>, css: string) {
    return class ReactView extends HTMLElement {
        /** Assigned by the platform before this element is connected. */
        host!: UnimicroHost;

        private mountPoint: HTMLDivElement;
        private root: Root | null = null;

        constructor() {
            super();

            // The view's own root, so its CSS is its own. Design tokens are custom properties and
            // cross this boundary; selector-based rules from the platform's stylesheets do not.
            const shadow = this.attachShadow({ mode: 'open' });
            adopt(shadow, css);

            // React owns this element and nothing else, so nothing it does can disturb the shadow
            // root itself. It is also the container React attaches its delegated listeners to,
            // which is what makes events work inside a shadow root at all.
            this.mountPoint = document.createElement('div');
            this.mountPoint.className = 'view';
            shadow.append(this.mountPoint);
        }

        connectedCallback(): void {
            // Already mounted: this is a move, and the tree below is untouched. Re-rendering would
            // be harmless; creating a second root would not be.
            if (this.root) return;

            this.root = createRoot(this.mountPoint);
            this.root.render(createElement(App, { host: this.host }));
        }

        disconnectedCallback(): void {
            // A move is a synchronous remove-then-insert, so by the time this microtask runs the
            // element is connected again and there is nothing to do. Only a real unmount leaves it
            // disconnected — and only then should the tree come down, because unmounting is what
            // runs every effect cleanup in it.
            queueMicrotask(() => {
                if (this.isConnected) return;

                const root = this.root;
                this.root = null;
                root?.unmount();
            });
        }
    };
}
