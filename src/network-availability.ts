// SPDX-License-Identifier: MPL-2.0
export function networkAvailable() {
  return navigator.onLine !== false;
}

export function subscribeNetworkAvailability(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}
