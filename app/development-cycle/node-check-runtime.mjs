// Host-owned preload, installed before any check/candidate module is evaluated.
// This deliberately supports a restricted ESM check runtime, not arbitrary Node
// instrumentation. The surrounding host must still provide OS confinement.
import assert from 'node:assert';
import strict from 'node:assert/strict';
import test, * as testExports from 'node:test';
import module from 'node:module';

const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major === 22 && minor >= 13 || major === 24) || !process.execArgv.includes('--frozen-intrinsics') ||
    !process.execArgv.includes('--no-addons') ||
    Object.getOwnPropertyDescriptor(Error.prototype, 'constructor')?.value !== Error) {
  throw new Error('unsupported protected Node check runtime');
}
const freeze = Object.freeze, descriptors = Object.getOwnPropertyDescriptors;
const define = Object.defineProperty, prototype = Object.getPrototypeOf;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const apply = Reflect.apply;
const values = Object.values, isFrozen = Object.isFrozen;
const seen = new WeakSet();
function immutable(value) {
  if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of values(descriptors(value))) {
    if ('value' in descriptor) immutable(descriptor.value);
    else { immutable(descriptor.get); immutable(descriptor.set); }
  }
  return freeze(value);
}
function unsupported() { throw new Error('unsupported mutation/instrumentation in protected Node checks'); }
function lock(object, key, value) {
  define(object, key, { value, configurable: false, writable: false });
}

// Protect the actual objects: ESM named exports can already reference them even
// if the default export's getters are subsequently replaced.
const registry = test.assert, mock = test.mock, snapshot = test.snapshot;
// Node 22's named assert export can be a different registry from test.assert.
for (const value of new Set([registry, testExports.assert].filter(Boolean))) {
  lock(value, 'register', unsupported);
  immutable(value);
}
for (const key of ['fn', 'method', 'getter', 'setter', 'property', 'module']) lock(prototype(mock), key, unsupported);
for (const key of ['enable', 'tick', 'setTime', 'runAll']) lock(prototype(mock.timers), key, unsupported);
for (const key of Object.keys(snapshot)) lock(snapshot, key, unsupported);
immutable(prototype(mock)); immutable(prototype(mock.timers));
for (const [key, value] of [['assert', registry], ['mock', mock], ['snapshot', snapshot]]) {
  if (value) lock(test, key, immutable(value));
}

// A candidate must not replace ESM/CJS builtins, instrument private Test objects,
// invoke native bindings, or evaluate into this realm through a debugger.
const denied = new Set(['module', 'vm', 'v8', 'inspector', 'inspector/promises',
  'async_hooks', 'diagnostics_channel', 'child_process', 'worker_threads', 'cluster']);
const builtinName = name => name.startsWith('node:') ? name.slice(5) : name;
const denyBuiltin = name => {
  if (denied.has(builtinName(name))) unsupported();
};
// Async hooks are also available on the minimum supported Node 22.13.
// Install before locking instrumentation; CommonJS remains refused at load time.
module.register(new URL('./node-check-hooks.mjs', import.meta.url), import.meta.url);
for (const key of ['register', 'registerHooks']) lock(module, key, unsupported);
const getBuiltinModule = process.getBuiltinModule.bind(process);
lock(process, 'getBuiltinModule', name => { denyBuiltin(name); return getBuiltinModule(name); });
for (const key of ['binding', '_linkedBinding', 'dlopen', '_debugProcess', '_debugEnd']) lock(process, key, unsupported);
module.syncBuiltinESMExports();

// Both the legacy and strict entry points (including Assert prototypes) share
// immutable implementations. --frozen-intrinsics also protects their primordials.
immutable(assert); immutable(strict); immutable(test);
// Lock each context before any candidate/user hook or body runs. In particular,
// t.assert is a separate mutable assertion table in Node, not assert's exports.
function protectContext(context) {
  const owner = prototype(context);
  if (!isFrozen(owner)) {
    const assertion = ownDescriptor(owner, 'assert');
    if (assertion?.get) define(owner, 'assert', {
      get() { return immutable(apply(assertion.get, this, [])); }, configurable: false,
    });
    if ('mock' in context) lock(owner, 'mock', undefined);
  }
  // Freeze lazily on access, preserving t.plan() before the first t.assert call.
  immutable(owner);
  freeze(context);
}
test.before(protectContext);
test.beforeEach(protectContext);
