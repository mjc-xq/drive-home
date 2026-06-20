// Minimal React error boundary. A synchronous throw inside <Canvas> during its initial
// render — e.g. WebGL2 context creation failing on a locked-down / low-memory mobile GPU
// — otherwise propagates to the React root and unmounts the ENTIRE app, including the DOM
// HUD, leaving a blank screen with no explanation. Wrapping the Canvas in this boundary
// keeps the rest of the app alive and renders a readable, recoverable fallback instead.

import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Da Hilg render error:', error, info);
  }

  render() {
    if (this.state.error) {
      if (typeof this.props.fallback === 'function') return this.props.fallback(this.state.error);
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
