/**
 * The design system's elements as JSX intrinsics. Types only — the platform registers <uni-*>
 * globally, and importing the package for real ships a second copy and throws on names the platform
 * already holds.
 *
 * The generated CustomElements map declares each element's properties, but its BaseEvents is `{}`
 * (see node_modules/@unimicro/design-system/dist/types/jsx.d.ts:61): there is no onClick, no
 * onInput, nothing React understands. Intersecting DOMAttributes back in is what makes
 * `<uni-button onClick={…}>` compile. React delegates those standard events at the root container,
 * and the design system dispatches its events composed, so they arrive.
 *
 * The design system's own custom events (uni-change, uni-close, …) are NOT reachable this way —
 * React only knows its own event names. Use a ref and addEventListener for those.
 */
import type { DOMAttributes } from 'react';
import type { CustomElements } from '@unimicro/design-system/types/jsx';

type UniIntrinsics = {
    [K in keyof CustomElements]: CustomElements[K] & DOMAttributes<HTMLElement>;
};

declare module 'react' {
    namespace JSX {
        interface IntrinsicElements extends UniIntrinsics {}
    }
}
