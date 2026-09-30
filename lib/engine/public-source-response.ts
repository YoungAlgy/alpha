// Shared bounds for public source feeds. The request's abort signal covers
// headers AND a body that stalls after headers, including mocked streams.
export const MAX_PUBLIC_SOURCE_BYTES = 256 * 1024;

export async function readPublicSourceText(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_PUBLIC_SOURCE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Public source response too large or invalid length");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Public source response missing body");
  let abortRead = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abortRead = () => {
      void reader.cancel().catch(() => {});
      reject(new Error("Public source response timed out"));
    };
    signal.addEventListener("abort", abortRead, { once: true });
  });
  const read = async () => {
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PUBLIC_SOURCE_BYTES) throw new Error("Public source response too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
  };
  try {
    if (signal.aborted) throw new Error("Public source response timed out");
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener("abort", abortRead);
    void reader.cancel().catch(() => {});
  }
}
