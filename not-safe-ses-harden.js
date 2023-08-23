console.warn('THIS IS NOT A SAFE VERSION OF SES-HARDEN! ONLY USE FOR EXPERIMENTS!');

top.harden = (function(){
  const {
    // The feral Error constructor is safe for internal use, but must not be
    // revealed to post-lockdown code in any compartment including the start
    // compartment since in V8 at least it bears stack inspection capabilities.
    Error: FERAL_ERROR,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
  } = globalThis;

  const hardened = new WeakSet();

  const isObject = value => Object(value) === value;

  const isCanonicalIntegerIndexString = propertyKey => {
    const n = +String(propertyKey);
    return Number.isInteger(n) && String(n) === propertyKey;
  };

  const isTypedArray = object => {
    // The object must pass a brand check or toStringTag will return undefined.
    const tag = Reflect.apply(Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(Uint8Array.prototype),
        Symbol.toStringTag,
    ).get, object, []);
    return tag !== undefined;
  };

  const freezeTypedArray = array => {
    Object.preventExtensions(array);

    // Downgrade writable expandos to readonly, even if non-configurable.
    // We get each descriptor individually rather than using
    // getOwnPropertyDescriptors in order to fail safe when encountering
    // an obscure GraalJS issue where getOwnPropertyDescriptor returns
    // undefined for a property that does exist.
    Reflect.ownKeys(array).forEach((/** @type {string | symbol} */ name) => {
      const desc = Object.getOwnPropertyDescriptor(array, name);
      if (!desc) throw new Error('no desc');
      // TypedArrays are integer-indexed exotic objects, which define special
      // treatment for property names in canonical numeric form:
      // integers in range are permanently writable and non-configurable.
      // https://tc39.es/ecma262/#sec-integer-indexed-exotic-objects
      //
      // This is analogous to the data of a hardened Map or Set,
      // so we carve out this exceptional behavior but make all other
      // properties non-configurable.
      if (!isCanonicalIntegerIndexString(name)) {
        Object.defineProperty(array, name, {
          ...desc,
          writable: false,
          configurable: false,
        });
      }
    });
  };

  function harden(root) {
    const toFreeze = new Set();
    const paths = new WeakMap();

    // If val is something we should be freezing but aren't yet,
    // add it to toFreeze.
    /**
     * @param {any} val
     * @param {string} [path]
     */
    function enqueue(val, path = undefined) {
      if (!isObject(val)) {
        // ignore primitives
        return;
      }
      const type = typeof val;
      if (type !== 'object' && type !== 'function') {
        // future proof: break until someone figures out what it should do
        throw TypeError(`Unexpected typeof: ${type}`);
      }
      if (hardened.has(val) || toFreeze.has(val)) {
        // Ignore if this is an exit, or we've already visited it
        return;
      }
      // console.warn(`adding ${val} to toFreeze`, val);
      toFreeze.add(val);
      paths.set(val, path);
    }

    /**
     * @param {any} obj
     */
    function freezeAndTraverse(obj) {
      // Now freeze the object to ensure reactive
      // objects such as proxies won't add properties
      // during traversal, before they get frozen.

      // Object are verified before being enqueued,
      // therefore this is a valid candidate.
      // Throws if this fails (strict mode).
      // Also throws if the object is an ArrayBuffer or any TypedArray.
      if (isTypedArray(obj)) {
        freezeTypedArray(obj);
      } else {
        Object.freeze(obj);
      }

      // we rely upon certain commitments of Object.freeze and proxies here

      // get stable/immutable outbound links before a Proxy has a chance to do
      // something sneaky.
      const path = paths.get(obj) || 'unknown';
      const descs = Object.getOwnPropertyDescriptors(obj);
      const proto = Object.getPrototypeOf(obj);
      enqueue(proto, `${path}.__proto__`);

      Reflect.ownKeys(descs).forEach((/** @type {string | symbol} */ name) => {
        const pathname = `${path}.${String(name)}`;
        // The 'name' may be a symbol, and TypeScript doesn't like us to
        // index arbitrary symbols on objects, so we pretend they're just
        // strings.
        const desc = descs[/** @type {string} */ (name)];
        // getOwnPropertyDescriptors is guaranteed to return well-formed
        // descriptors, but they still inherit from Object.prototype. If
        // someone has poisoned Object.prototype to add 'value' or 'get'
        // properties, then a simple 'if ("value" in desc)' or 'desc.value'
        // test could be confused. We use hasOwnProperty to be sure about
        // whether 'value' is present or not, which tells us for sure that
        // this is a data property.
        if (Object.hasOwnProperty(desc, 'value')) {
          enqueue(desc.value, `${pathname}`);
        } else {
          enqueue(desc.get, `${pathname}(get)`);
          enqueue(desc.set, `${pathname}(set)`);
        }
      });
    }

    function dequeue() {
      // New values added before forEach() has finished will be visited.
      toFreeze.forEach(freezeAndTraverse);
    }

    /** @param {any} value */
    function markHardened(value) {
      hardened.add(value);
    }

    function commit() {
      toFreeze.forEach(markHardened);
    }

    enqueue(root);
    dequeue();
    // console.warn("toFreeze set:", toFreeze);
    commit();

    return root;
  }

  return harden;
}());
