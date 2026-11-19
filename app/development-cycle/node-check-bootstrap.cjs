// --require runs before --frozen-intrinsics; --import runs after it. Keep the
// data-descriptor constructor identities used by Node's error serializer.
// Otherwise frozen-intrinsics turns these into accessors and real assertion
// failures lose their failureType/code while crossing the runner boundary.
// Async loader threads on Node 22 run inherited preloads after freezing. They
// never execute candidate code; the main test process still requires data descriptors.
if (require('node:worker_threads').isMainThread) for (const ctor of [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError]) {
  Object.defineProperty(ctor.prototype, 'constructor', {
    value: ctor, configurable: false, writable: false,
  });
}
