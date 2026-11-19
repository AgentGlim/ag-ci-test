// Host-owned loader thread. Never import candidate code into this realm.
const denied = new Set(['module', 'vm', 'v8', 'inspector', 'inspector/promises',
  'async_hooks', 'diagnostics_channel', 'child_process', 'worker_threads', 'cluster']);
export function resolve(specifier, context, next) {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (denied.has(name)) throw new Error('unsupported mutation/instrumentation in protected Node checks');
  return next(specifier, context);
}
export async function load(url, context, next) {
  const result = await next(url, context);
  if (!['module', 'builtin', 'json'].includes(result.format)) {
    throw new Error('unsupported mutation/instrumentation in protected Node checks');
  }
  return result;
}
