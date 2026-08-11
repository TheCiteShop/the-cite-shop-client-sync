/**
 * SHA-256 of a UTF-8 string, lowercase hex.
 *
 * Must stay byte-identical to the backend's `hash('sha256', $content)` over the
 * raw .csl file, since the two are compared to decide whether an installed file
 * is one of ours.
 */
export async function sha256Hex(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
