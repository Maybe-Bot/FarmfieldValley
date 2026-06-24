/**
 * Browser entry point.
 *
 * React starts here, global CSS is loaded here, and the error boundary prevents
 * one frontend bug from turning into an unexplained blank screen.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "leaflet/dist/leaflet.css";

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Loam Ledger UI crashed", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="auth-shell">
          <div className="card auth-card">
            <h2>The app hit a display error</h2>
            <p className="muted">This is a frontend display problem, not your farm data being deleted. Reload the app and try again.</p>
            <button className="primary-button" type="button" onClick={() => window.location.reload()}>
              Reload app
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
