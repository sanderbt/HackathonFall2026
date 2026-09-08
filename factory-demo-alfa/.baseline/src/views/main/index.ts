import { createReactView } from '#lib/react-view';
import App from './App';
// The view carries its own stylesheet, adopted on its own root, the same way in either model.
// `?inline` is not a preference: Vite emits a view's CSS as its own file and leaves the linking to
// an HTML page, which a plugin view does not have.
import styles from './view.css?inline';

/**
 * A plugin view is a custom element, default-exported from the file the manifest names as its
 * entry. createReactView holds the lifecycle; App holds the view.
 */
export default createReactView(App, styles);
