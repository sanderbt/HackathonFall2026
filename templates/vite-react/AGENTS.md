# Working in this repository

This is a Unimicro platform plugin, built with **React + Vite**. Platform documentation is
installed as skill files in `.claude/skills`.

## How a view is written in this project

A view is two or three files in `src/views/<id>/`:

- `index.ts` — four lines: `export default createReactView(App, styles)`. Do not put JSX here, and
  do not rename it to `index.tsx`: the manifest, the build's input glob in `vite.config.ts`, and
  `dev.entryMap` in `unimicro.config.json` all name `index.ts`.
- `App.tsx` — the React component. It takes `{ host }` and nothing else.
- `view.css` — imported as `./view.css?inline` and adopted on the view's own root. A plain
  `import './view.css'` produces a stylesheet nothing loads, and the build warns about it.

`src/lib/react-view.ts` holds the custom-element lifecycle. Do not reimplement it per view, and do
not simplify it: an element moved in the DOM disconnects and reconnects on the same live handle, so
the root must survive a move and come down only on a real unmount. There is a test for this.

## Rules that are not style preferences

- `<uni-*>` elements are registered by the platform. **Never `import '@unimicro/design-system'`** —
  it adds ~200 kB to every view and calls `customElements.define` on names the platform already
  holds. The JSX types are already wired up in `src/types/design-system-jsx.d.ts`.
- Use design tokens (`var(--text-default)`) freely; they cross the shadow boundary. The platform's
  selector-based utility classes do not.
- Anything you open yourself — `fetch`, `EventSource`, `setInterval` — you close yourself, in a
  `useEffect` cleanup. The platform revokes `host` at unmount and releases the subscriptions it
  granted; it knows nothing about a socket you opened.
- Catch `host/revoked` and return. It means the user left, not that something is broken.
- No React portals to `document.body` — that leaves the shadow root the platform owns. Use
  `<uni-drawer>`, `<uni-popover>` or `host.dialog.*`.
- No `index.html`, no second dev server, no host page for your views.
- Do not edit `vite.config.ts` or `tsconfig.json`. Every setting in them is a contract with
  `unimicro plugin dev`, documented in comments.

## Verifying a change

In this order — `validate` reports `entryFileMissing` unless `build` has run:

```sh
npm run check      # tsc --noEmit
npm test           # vitest
npm run build      # vite build
unimicro plugin validate --json
```

Do **not** wait on `unimicro plugin dev` output for a build verdict. This project uses proxy dev
mode, where `verdicts` is false and `build.succeeded` / `build.failed` never arrive.

## Platform skills

Read the one that matches what you are doing:

- `.claude/skills/cli/` — the Unimicro CLI: commands, project configuration and the dev loop.
- `.claude/skills/host-api/` — the host handle, member by member: dialogs, notifications,
  navigation, logging, `getContext` and slot context, plus the error codes calls reject with.
- `.claude/skills/platform-api/` — reading and writing platform data through `host.api`: which
  entities exist, what route each answers on, exact field names, filter and paging syntax.
- `.claude/skills/plugin-dev/` — manifest format, view models, and the publish flow.
- `.claude/skills/design-system/` — component APIs and examples, design tokens, setup.

These files are managed by the Unimicro CLI (`unimicro plugin skills update`). Edit them only if you
intend to keep local changes; the CLI will not overwrite edited files.
