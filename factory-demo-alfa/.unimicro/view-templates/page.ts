import { createElement, useEffect } from 'react';
import { createReactView, type ViewProps } from '#lib/react-view';

/**
 * A plugin view is a custom element, default-exported from the file the manifest names as its
 * entry. createReactView wraps a React component in one and holds the lifecycle.
 *
 * Written with createElement rather than JSX because this file is a `.ts` entry: the manifest, the
 * build's input glob and `dev.entryMap` all name index.ts. To use JSX, put the component in an
 * App.tsx beside this file and reduce this file to:
 *
 *     import { createReactView } from '#lib/react-view';
 *     import App from './App';
 *     import styles from './view.css?inline';
 *     export default createReactView(App, styles);
 *
 * The `#lib/*` import is a package.json subpath, not a relative path, so this file compiles both
 * here and at src/views/<id>/index.ts, which is where `unimicro plugin add view` copies it.
 */
const title = `__VIEW_TITLE__`;

function __VIEW_CLASS__({ host }: ViewProps) {
    useEffect(() => {
        host.log.info('view opened');
    }, [host]);

    return createElement('section', null, createElement('h1', null, title));
}

export default createReactView(
    __VIEW_CLASS__,
    ':host{display:block}.view{color:var(--text-default);font-family:var(--font-family)}section{padding:2rem}',
);
