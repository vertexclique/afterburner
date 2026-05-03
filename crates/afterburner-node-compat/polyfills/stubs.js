// Stubs were the parking spot for Node modules we hadn't yet
// polyfilled. Every entry that lived here used to register a Proxy
// that threw on first property access, naming the module so users
// got a clear "not supported" signal.
//
// As of the round-2 Node 20 coverage pass, every Node 20 LTS
// built-in has a real polyfill (see the matching `polyfills/<name>.js`
// file). This file is intentionally empty so the bundle order
// (alphabetical concat) doesn't clobber any real polyfill that
// sorts before `stubs.js`. Keeping the file around — instead of
// deleting it — preserves a stable hook for any future
// "intentionally not supported" module without re-introducing the
// alphabetical-clobber footgun.
