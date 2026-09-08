// SPDX-License-Identifier: MPL-2.0
export interface EditorBuffer {
  text: string;
  past: string[];
  future: string[];
}
export type EditorAction =
  { type: "change" | "load"; text: string } | { type: "undo" | "redo" };
export const normaliseText = (text: string) => text.replace(/\r\n/g, "\n");
export const lineEnding = (text: string) =>
  text.includes("\r\n") && !text.replace(/\r\n/g, "").includes("\n")
    ? "CRLF"
    : "LF";
export const serialiseText = (text: string, ending: string) =>
  ending === "CRLF" ? text.replace(/\n/g, "\r\n") : text;
export function editBuffer(
  state: EditorBuffer,
  action: EditorAction,
): EditorBuffer {
  if (action.type === "load")
    return { text: normaliseText(action.text), past: [], future: [] };
  if (action.type === "change")
    return action.text === state.text
      ? state
      : {
          text: action.text,
          past: [...state.past.slice(-49), state.text],
          future: [],
        };
  if (action.type === "undo")
    return state.past.length
      ? {
          text: state.past.at(-1)!,
          past: state.past.slice(0, -1),
          future: [state.text, ...state.future],
        }
      : state;
  return state.future.length
    ? {
        text: state.future[0],
        past: [...state.past, state.text],
        future: state.future.slice(1),
      }
    : state;
}
