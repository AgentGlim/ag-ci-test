// --require runs before --frozen-intrinsics; --import runs after it. Keep the
// data-descriptor constructor identities used by Node's error serializer.
// Otherwise frozen-intrinsics turns these into accessors and real assertion
// failures lose their failureType/code while crossing the runner boundary.
for (const ctor of [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError]) {
  Object.defineProperty(ctor.prototype, 'constructor', {
    value: ctor, configurable: false, writable: false,
  });
}
