// Tiny conditional-class helper. Mirrors clsx semantics but ships zero deps
// — the roboapply-app boundary stays narrow.

export function cn(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}
