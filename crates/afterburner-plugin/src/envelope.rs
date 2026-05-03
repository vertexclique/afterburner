//! JS source envelopes. Each user source is wrapped to:
//!
//! 1. Load input into a local `__ab_data`.
//! 2. Install a `module` / `exports` pair plus the plenum `require`.
//! 3. Invoke the user function and `JSON.stringify` the result to stdout.
//! 4. If the result is a Promise, `await` it (Javy's event-loop drain
//!    surfaces unhandled rejections as module-evaluation errors).

use alloc::format;
use alloc::string::String;

/// Envelope for the legacy mode: user source is compiled and run
/// together, with the input literal inlined into the JS text.
pub fn wrap_user_source(user: &str, input_json: &str) -> String {
    let user_lit = js_string_literal(user);
    let input_lit = js_string_literal(input_json);
    format!(
        r#"
        function __ab_write_stdout(s) {{
            Javy.IO.writeSync(1, new TextEncoder().encode(s));
        }}
        const __ab_data = JSON.parse({input_lit});
        const __ab_module = {{ exports: undefined }};
        const __ab_user = new Function('module', 'exports', 'require', {user_lit});
        __ab_user(__ab_module, __ab_module.exports, globalThis.require);
        const __ab_fn = __ab_module.exports;
        const __ab_maybe = (typeof __ab_fn === 'function') ? __ab_fn(__ab_data) : __ab_fn;
        const __ab_result = (__ab_maybe !== null && typeof __ab_maybe === 'object' && typeof __ab_maybe.then === 'function')
            ? await __ab_maybe
            : __ab_maybe;
        __ab_write_stdout(JSON.stringify(__ab_result === undefined ? null : __ab_result));
        "#
    )
}

/// Bytecode-cache variant of [`wrap_user_source`]. The compiled
/// bytecode is *input-agnostic* — it pulls the per-call input JSON
/// directly from the host via the `__AB_GET_INPUT__` global installed
/// in `globals::install`. Identical Promise / await semantics to the
/// inlined-input version above; the only difference is the input
/// source. Skipping the per-call preamble compile cuts ~150 µs from
/// the hot path.
pub fn wrap_user_source_with_input_global(user: &str) -> String {
    let user_lit = js_string_literal(user);
    format!(
        r#"
        function __ab_write_stdout(s) {{
            Javy.IO.writeSync(1, new TextEncoder().encode(s));
        }}
        const __ab_data = JSON.parse(__AB_GET_INPUT__());
        const __ab_module = {{ exports: undefined }};
        const __ab_user = new Function('module', 'exports', 'require', {user_lit});
        __ab_user(__ab_module, __ab_module.exports, globalThis.require);
        const __ab_fn = __ab_module.exports;
        const __ab_maybe = (typeof __ab_fn === 'function') ? __ab_fn(__ab_data) : __ab_fn;
        const __ab_result = (__ab_maybe !== null && typeof __ab_maybe === 'object' && typeof __ab_maybe.then === 'function')
            ? await __ab_maybe
            : __ab_maybe;
        __ab_write_stdout(JSON.stringify(__ab_result === undefined ? null : __ab_result));
        "#
    )
}

/// Envelope for script mode. The user source runs as top-level code
/// inside a Node-style CommonJS wrapper (`module` / `exports` /
/// `require` bound as parameters). Unlike the UDF wrappers above, we
/// do **not** call `module.exports(input)` afterward — script mode
/// runs whatever the user wrote top-level and exits when that
/// finishes. Stdout comes from `console.log` (plenum's console
/// polyfill), not from `JSON.stringify(result)`.
///
/// `argv_json` / `env_json` must be valid JSON literals (array and
/// object respectively) — they are inlined into the JS text verbatim
/// and become `process.argv` / `process.env`. The process polyfill
/// was bootstrapped at Wizer-preinit time with empty argv/env, so we
/// also mutate the live `globalThis.process` here to refresh those
/// fields per invocation.
///
/// `cwd_json` is a JSON string literal (including quotes). It becomes
/// `globalThis.__host_cwd` so `process.cwd()` + the B6 `require()`
/// resolver have a working baseline for path-relative lookups when
/// the entry script is eval'd (`[eval]` has no dirname of its own).
///
/// Top-level `await` inside user source resolves through Javy's
/// event-loop drain: the outer wrapper itself is compiled as an ES
/// module, so a rejecting Promise surfaces as a module-evaluation
/// error that `invoke` returns as `Err` — exactly how we want script
/// errors to flow back to the host as a WASM trap.
pub fn wrap_script_source(
    user: &str,
    argv_json: &str,
    env_json: &str,
    cwd_json: &str,
) -> String {
    let user_lit = js_string_literal(user);
    // The user wrapper is an `AsyncFunction` so top-level `await`
    // inside the user's source compiles. The plain `Function`
    // constructor creates a sync function body; an `await` inside
    // would parse as the identifier "await" and trip a "expecting ';'"
    // SyntaxError. With AsyncFunction the body parses as an async
    // function, await is legal, and the function returns a Promise we
    // can `await` from the outer wrapper.
    format!(
        r#"
        globalThis.__ab_argv = {argv_json};
        globalThis.__host_env = {env_json};
        globalThis.__host_cwd = {cwd_json};
        if (globalThis.process) {{
            globalThis.process.argv = globalThis.__ab_argv;
            globalThis.process.env  = globalThis.__host_env;
        }}
        // rebase the require resolver on the freshly-set cwd so
        // `require('./foo')` in an eval script lands in the user's
        // invocation directory.
        if (typeof globalThis.__plenum_refresh_entry_require === 'function') {{
            globalThis.__plenum_refresh_entry_require();
        }}
        const __ab_AsyncFunction = (async function () {{}}).constructor;
        const __ab_module = {{ exports: {{}} }};
        const __ab_user = new __ab_AsyncFunction(
            'module', 'exports', 'require', {user_lit}
        );
        await __ab_user(__ab_module, __ab_module.exports, globalThis.require);
        "#
    )
}

pub fn js_string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            ch if (ch as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}
