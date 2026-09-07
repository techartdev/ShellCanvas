// SPDX-License-Identifier: MPL-2.0
import { Component, type ReactNode } from "react";

/** Contains render/lifecycle failures. Async and event errors belong to the app. */
export class AppBoundary extends Component<
  { title: string; children: ReactNode },
  { failed: boolean; attempt: number }
> {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="app-empty" role="alert">
          <h2>{this.props.title} stopped unexpectedly</h2>
          <p>
            You can reopen this app. Your other windows are still available.
          </p>
          <button
            className="primary-button"
            onClick={() =>
              this.setState(({ attempt }) => ({
                failed: false,
                attempt: attempt + 1,
              }))
            }
          >
            Reopen app
          </button>
        </div>
      );
    return (
      <div className="app-surface" key={this.state.attempt}>
        {this.props.children}
      </div>
    );
  }
}
