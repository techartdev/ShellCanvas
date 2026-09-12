// SPDX-License-Identifier: MPL-2.0
/** The terminal mark shared with the website and native app icon. */
export function ShellCanvasMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="28" height="23" rx="5" />
      <path
        d="m8 11 5 5-5 5m9 0h7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
