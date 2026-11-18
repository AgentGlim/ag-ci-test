// These journeys run synchronous CLIs between HTTP assertions. A blocked test event
// loop cannot observe an idle pooled socket closing while a slow Windows CLI runs.
// Use a new connection; never retry requests (especially POSTs).
export function freshFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('connection', 'close');
  return fetch(url, { ...options, headers });
}
