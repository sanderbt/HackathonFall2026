import { createElement, useEffect, useState } from 'react';
import { createReactView, type ViewProps } from '#lib/react-view';

/** What this slot hands the view. Narrow it to the entity your slot actually provides. */
type SlotSubject = { Info?: { Name?: string }; Name?: string } | null | undefined;

/** The subject's display name, wherever the entity keeps it. */
function subjectName(entity: SlotSubject): string {
    return entity?.Info?.Name ?? entity?.Name ?? '';
}

function __VIEW_CLASS__({ host }: ViewProps) {
    const [subject, setSubject] = useState('');

    // The entity of the page this view sits in, and every update as the page works. Subscribing is
    // the whole of it: the handler is called with the value the slot holds now, and again on every
    // change. Fetching a first value with getContext() and subscribing after is both redundant and
    // wrong — an update landing while that await is in flight is overwritten by the older value.
    //
    // Returning the unsubscribe as the effect cleanup is the correct React idiom and happens to be
    // exactly what the platform asks for: an element moved in the DOM disconnects and reconnects on
    // the same live handle, and would otherwise subscribe again each time.
    useEffect(
        () => host.slot?.onContextChange<SlotSubject>((updated) => setSubject(subjectName(updated))),
        [host],
    );

    return createElement('section', null, createElement('h1', null, subject || '—'));
}

export default createReactView(
    __VIEW_CLASS__,
    ':host{display:block}.view{color:var(--text-default);font-family:var(--font-family)}section{padding:1rem}',
);
