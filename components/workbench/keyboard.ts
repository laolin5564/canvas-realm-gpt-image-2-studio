import type { KeyboardEvent } from "react";

/** ⌘/Ctrl + Enter 提交，工作台三处 prompt 输入共用。 */
export function isSubmitShortcut(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}
