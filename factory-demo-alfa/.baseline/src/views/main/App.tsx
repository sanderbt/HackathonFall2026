import { useEffect, useState } from 'react';
import type { HostError } from '@unimicro/plugin-types';
import type { ViewProps } from '#lib/react-view';

/**
 * A rejection from the host, which carries a stable `code` — `host/revoked`, `host/request-failed`
 * and the rest. Branch on that and never on the message: the message is for a human reading a log.
 */
function isHostError(error: unknown): error is HostError {
    return error instanceof Error && 'code' in error;
}

export default function App({ host }: ViewProps) {
    const [companyName, setCompanyName] = useState('');
    const [failure, setFailure] = useState('');

    useEffect(() => {
        let live = true;

        host.getContext()
            .then((context) => {
                if (live) setCompanyName(context.company.name);
            })
            .catch((error: unknown) => {
                // The view was unmounted while the call was in flight — its handle is dead and so is
                // everything it could render into. There is nobody left to tell.
                if (!live) return;
                if (isHostError(error) && error.code === 'host/revoked') return;

                setFailure('Could not read which company this is running in.');

                // Attributed to this plugin, and visible to whoever supports it. The user gets the
                // line above; the reason belongs here.
                host.log.error(error, { view: 'main' });
            });

        return () => {
            live = false;
        };
    }, [host]);

    return (
        <section>
            <h1>Factory Demo</h1>

            {failure ? (
                <uni-alert type="critical">{failure}</uni-alert>
            ) : (
                <p>Running in {companyName || 'this company'}.</p>
            )}

            <uni-alert>
                The design system's components are available here, and the platform's design tokens
                reach into this view — so it can look like part of the product.
            </uni-alert>
        </section>
    );
}
