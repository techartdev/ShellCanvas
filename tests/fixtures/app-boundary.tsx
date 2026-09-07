// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppBoundary } from "../../src/components/AppBoundary";

function FailingApp() {
  const [failed, setFailed] = useState(false);
  if (failed) throw new Error("Intentional app boundary fixture failure");
  return <button onClick={() => setFailed(true)}>Trigger app failure</button>;
}
function Fixture() {
  const [count, setCount] = useState(0);
  return (
    <>
      <button onClick={() => setCount(count + 1)}>
        Sibling counter: {count}
      </button>
      <AppBoundary title="Fixture">
        <FailingApp />
      </AppBoundary>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
