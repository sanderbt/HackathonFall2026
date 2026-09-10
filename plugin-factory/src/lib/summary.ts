/**
 * The agent's closing message, reduced to one line of prose.
 *
 * It writes Markdown, because it writes for a terminal: a turn ends in headings, bold runs,
 * bulleted lists and the odd emoji. Verbatim on screen that arrived as literal `##` and `**` down
 * the middle of the view, cut off mid-word by a line clamp — which is the one piece of the agent's
 * narration written for the reader looking like a broken template.
 *
 * Not a Markdown renderer, and deliberately not: the report is often a page long, and headings and
 * bullets rendered properly would give the payoff screen a document in the middle of it. What
 * belongs there is the sentence that says what was built.
 */

/** As much of the agent's closing message as a payoff screen has room for. */
const SUMMARY_MAX = 220;

/** The markers that only mean something at the start of a line. */
function unmark(line: string): string {
    return line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
        .trim();
}

/**
 * The wrappers that would otherwise be read out loud.
 *
 * Emphasis is matched as a pair rather than stripped character by character, so `snake_case` and
 * an arithmetic `*` survive: a lone marker is not markup, and removing it corrupts the word.
 */
function unwrap(text: string): string {
    return text
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

export function lead(text: string): string {
    // Fenced code is never the summary; it is also the one place where a `#` or a `-` at the start
    // of a line means itself, so it goes before anything else is unmarked.
    const blocks = text.replace(/```[\s\S]*?```/g, '\n\n').split(/\n\s*\n/);

    let out = '';
    for (const block of blocks) {
        const lines = block
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        if (lines.length === 0) continue;
        // A heading on its own line labels what comes after it — "What was built:" — so taking it
        // as the summary would print the caption and drop the thing it captions.
        if (lines.length === 1 && /^#{1,6}\s/.test(lines[0])) continue;

        let joined = '';
        for (const line of lines) {
            const text = unmark(line);
            if (!text) continue;
            if (!joined) {
                joined = text;
                continue;
            }
            // Bullets are separate statements, and a list is written without the punctuation that
            // would separate them in a sentence. Run together with a space they read as one
            // sentence that lost its full stops.
            const item = /^(?:[-*+]|\d+[.)])\s/.test(line);
            joined += item && !/[.!?;:,]$/.test(joined) ? `; ${text}` : ` ${text}`;
        }

        const cleaned = unwrap(joined);
        if (!cleaned) continue;

        out = out ? `${out} ${cleaned}` : cleaned;
        // One paragraph is usually the whole of it. "Done!" on its own is not, and neither is the
        // "All four gates passed." a turn sometimes opens with, so a short one takes the next too.
        if (out.length >= 60) break;
    }

    if (out.length <= SUMMARY_MAX) {
        // Trailing punctuation that promises a list which is not coming. There is more, and the
        // ellipsis is where it says so.
        return out.replace(/[:;,]$/, '…');
    }

    const cut = out.slice(0, SUMMARY_MAX);
    const space = cut.lastIndexOf(' ');
    // Back to a word boundary, unless the last word is long enough that the cut is most of the
    // line — a summary of two words plus an ellipsis says less than a clipped one.
    const kept = space > SUMMARY_MAX * 0.6 ? cut.slice(0, space) : cut;
    return `${kept.replace(/[\s.,;:!?]+$/, '')}…`;
}
