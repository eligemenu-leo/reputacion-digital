/**
 * Hash SHA-256 (hex) del texto EXACTO de una respuesta. Es el mismo cálculo que
 * hace PostgreSQL (`encode(sha256(convert_to(content,'UTF8')),'hex')`) para
 * verificar que se publica exactamente el texto aprobado.
 * Usa Web Crypto para funcionar igual en navegador y Node.
 */
export async function responseHash(content: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
