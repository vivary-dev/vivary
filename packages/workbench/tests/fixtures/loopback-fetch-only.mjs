const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error(`The isolated OAuth fixture refuses a fetch outside loopback: ${url.origin}`);
  }
  return originalFetch(input, init);
};
