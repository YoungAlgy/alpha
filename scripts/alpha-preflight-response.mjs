// Pure bounded response reader, shared by preflights and offline stub tests.
export async function readBoundedJson(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !response.body) {
    throw new Error("invalid_response");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("response_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
