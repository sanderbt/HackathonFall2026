import type { ServerResponse } from 'node:http';
import type { FactoryEvent, FactoryEventBody } from './protocol.ts';

/** How many events a session keeps for replay. A runaway build loop must not grow this forever. */
const RING_SIZE = 500;

/**
 * One session's event stream: a monotonic sequence, a bounded replay buffer, and the set of
 * currently attached SSE responses.
 *
 * The buffer is what makes reconnection free. `EventSource` retries on its own and sends
 * `Last-Event-ID`; replaying from there means a dropped connection loses nothing, which matters
 * because this stream is watched inside a plugin view in someone else's page.
 */
export class EventBus {
    private seq = 0;
    private ring: FactoryEvent[] = [];
    private clients = new Set<ServerResponse>();

    /** Everything buffered, for `GET /api/sessions/:id` to paint from. */
    get history(): FactoryEvent[] {
        return [...this.ring];
    }

    emit(event: FactoryEventBody): FactoryEvent {
        const full = { ...event, seq: ++this.seq } as FactoryEvent;

        this.ring.push(full);
        if (this.ring.length > RING_SIZE) this.ring.shift();

        const frame = `id: ${full.seq}\ndata: ${JSON.stringify(full)}\n\n`;
        for (const client of this.clients) client.write(frame);

        return full;
    }

    /**
     * Attach an SSE response, replaying anything it missed.
     *
     * `X-Accel-Buffering: no` is not optional if anything ever proxies this — nginx will otherwise
     * buffer the whole stream and the user sees nothing until the run ends.
     */
    attach(res: ServerResponse, lastEventId: number | null): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        });

        // Tell EventSource to back off a little before retrying, then replay the gap.
        res.write('retry: 2000\n\n');
        for (const event of this.ring) {
            if (lastEventId !== null && event.seq <= lastEventId) continue;
            res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        }

        this.clients.add(res);

        // Comment frames keep intermediaries from deciding the connection is idle.
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

        const drop = () => {
            clearInterval(heartbeat);
            this.clients.delete(res);
        };
        res.on('close', drop);
        res.on('error', drop);
    }

    closeAll(): void {
        for (const client of this.clients) client.end();
        this.clients.clear();
    }
}
