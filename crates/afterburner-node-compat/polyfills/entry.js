// plenum.js bundle entry point.
//
// Concatenated pieces in order:
//   1. require.js          — installs require() + __register_module
//   2. individual polyfill files (path.js, url.js, buffer.js, …) each
//      call __register_module('name', function(module, exports, require) {…})
//      — wired in Step 2.
//
// The file itself is a marker for the build script to identify the entry.
// At runtime it is concatenated in front of all polyfills, so it simply
// ensures that if someone evals the bundle as a single blob, the
// resolver is installed before any polyfill body references `require`.
//
// (Keeping this as a short comment-only file avoids a no-op IIFE
// that would show up in stack traces.)
