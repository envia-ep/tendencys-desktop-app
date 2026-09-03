/** Replaces a leading @handle, or prefixes one when the composer has none. */
export function applyAgentHandle(prompt: string, handle: string): string {
  const rest = prompt.replace(/^@[^\s]+\s*/, "").trimStart();
  return rest ? `@${handle} ${rest}` : `@${handle} `;
}
