/**
 * V8's `Object::GetConstructorName` reads the object's creation map, which
 * keeps the name of the constructor an object was created with even after its
 * prototype has been dropped (`Object.setPrototypeOf(obj, null)`). Node's
 * `util.inspect` therefore renders such an object as
 * `[Foo: null prototype] {}`.
 *
 * That map is not observable from JavaScript, so the shim records the
 * constructor name at the moment the prototype is dropped. The patch is
 * installed once, lazily, and only observes `Object.setPrototypeOf` — it never
 * changes the result of the call.
 *
 * The same patch records the class tag (`Object.prototype.toString` tag) the
 * object had before the swap. That tag is how `Error` instances stay
 * recognisable as errors once their prototype is gone: `instanceof Error` and
 * `Object.prototype.toString` both stop reporting an error, but V8 keeps the
 * internal slot, and Node's `isNativeError` still says yes.
 */

/** What the shim remembers about an object whose prototype was dropped. */
export interface NullPrototypeInfo {
  /** The constructor name V8's creation map still remembers. */
  constructorName: string | undefined;
  /** The `Object.prototype.toString` tag the object had before the swap. */
  classTag: string;
  /** Whether the object was an `Error` instance before the swap. */
  isError: boolean;
}

const nullPrototypeInfo = new WeakMap<object, NullPrototypeInfo>();

/** The constructor name of a prototype chain, or undefined when unknown. */
const constructorNameOf = (proto: object | null): string | undefined => {
  let current: object | null = proto;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "constructor");
    if (descriptor !== undefined && typeof descriptor.value === "function") {
      const name = descriptor.value.name;
      if (name !== "") return name;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
};

const PATCHED = Symbol.for("bolojs.node-web-shims.nullPrototypeNames");

interface SetPrototypeOfHost {
  [PATCHED]?: boolean;
}

const install = (): void => {
  const host = Object as unknown as SetPrototypeOfHost;
  if (host[PATCHED]) return;
  host[PATCHED] = true;
  const original = Object.setPrototypeOf;
  Object.setPrototypeOf = function setPrototypeOf(
    this: unknown,
    o: object | null,
    proto: object | null,
  ): object {
    // Only the null-prototype transition loses the observable constructor, so
    // the previous prototype has to be read *before* the swap.
    const previous =
      proto === null && o !== null && typeof o === "object"
        ? Object.getPrototypeOf(o)
        : undefined;
    let classTag = "";
    let isError = false;
    if (previous !== undefined && previous !== null) {
      classTag = Object.prototype.toString.call(o);
      isError = o instanceof Error;
    }
    const result = original.call(this, o, proto) as object;
    if (previous !== undefined && previous !== null) {
      nullPrototypeInfo.set(o as object, {
        constructorName: constructorNameOf(previous as object),
        classTag,
        isError,
      });
    }
    return result;
  } as typeof Object.setPrototypeOf;
};

/**
 * What the shim remembers about `value` after its prototype was dropped, or
 * undefined when the object still has a normal prototype.
 */
export const nullPrototypeInfoOf = (value: object): NullPrototypeInfo | undefined =>
  nullPrototypeInfo.get(value);

/**
 * The constructor name V8 would report for `value`, or undefined when the
 * object has a normal prototype (its constructor is found by walking the
 * prototype chain).
 */
export const nullPrototypeConstructorName = (value: object): string | undefined =>
  nullPrototypeInfo.get(value)?.constructorName;

// Install eagerly: the constructor name has to be recorded at the moment the
// prototype is dropped, which can happen before the first inspection.
install();
