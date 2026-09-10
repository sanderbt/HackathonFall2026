/**
 * How a running build is described on screen, shared by the full page and the dashboard widget.
 *
 * Both surfaces watch the same session, so they have to say the same things about it: two
 * vocabularies for one build is how the widget ends up claiming "Sjekker…" while the page it links
 * to says "Bygger…".
 */

import type { SessionState } from '#lib/orchestrator';

/**
 * The four things a person waiting on this actually wants to know: where in the process we are,
 * that it is still moving, roughly how long it has been, and where the result is.
 *
 * Everything the agent narrates about itself — tool calls, skill reads, gate output — is progress
 * *evidence*, not progress *information*.
 */
export type Phase = 'prepare' | 'build' | 'check' | 'done';

export const PHASE_OF: Record<SessionState, Phase | null> = {
    created: 'prepare',
    provisioning: 'prepare',
    'dev-starting': 'prepare',
    live: null,
    working: 'build',
    verifying: 'check',
    updated: 'done',
    failed: null,
    closed: null,
};

export const STEPS: { phase: Phase; name: string }[] = [
    { phase: 'prepare', name: 'Gjør klar' },
    { phase: 'build', name: 'Bygger' },
    { phase: 'check', name: 'Sjekker' },
    { phase: 'done', name: 'Klar' },
];

/**
 * What to say while waiting.
 *
 * These rotate on a timer *and* advance whenever the agent reports having done something, so the
 * line moves for two independent reasons — which means a line that stops moving really has
 * stopped. They are vague on purpose: an honest "still working on it" beats a precise claim the
 * backend cannot back up.
 */
export const CHATTER: Record<Phase, string[]> = {
    prepare: [
        'Vekker verkstedet…',
        'Slår ut arbeidsbenken…',
        'Kobler til kablene…',
        'Låner et testfirma…',
        'Legger fram verktøyet…',
    ],
    build: [
        'Skisserer oppsettet…',
        'Skriver koden…',
        'Setter delene sammen…',
        'Finpusser detaljene…',
        'Navngir ting — den vanskelige delen…',
        'Strammer noen skruer…',
        'Kobler den til dataene dine…',
    ],
    check: ['Leser gjennom, to ganger…', 'Ser om den vipper…', 'Prøver hver knapp…', 'Sjekker hjørnene…'],
    done: ['Helt ferdig.'],
};

/** How long a build may run before a view stops calling it normal and offers a way out. */
export const SLOW_AFTER = 180;

export function clock(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
