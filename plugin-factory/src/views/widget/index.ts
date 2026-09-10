import { createReactView } from '#lib/react-view';
import App from './App';
// `?inline` is not a preference: Vite emits a view's CSS as its own file and leaves the linking to
// an HTML page, which a plugin view does not have.
import styles from './view.css?inline';

export default createReactView(App, styles);
