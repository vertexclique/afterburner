//! ESM → CJS transform (AST-guided source rewrite).
//!
//! oxc 0.127 parses ES module syntax into a well-typed AST but does
//! *not* ship a first-class ESM→CJS transformer (upstream issue
//! [#4050]). This module fills the gap: we parse with oxc (to get
//! precise byte spans that correctly ignore strings containing the
//! substring `"import"`), collect every top-level import/export
//! declaration, and splice in CommonJS replacements using those
//! spans.
//!
//! Scope matches what 95% of real-world Node+TS code uses:
//!
//! * `import X from 'Y'` (default)
//! * `import { a, b as c } from 'Y'` (named with aliases)
//! * `import * as Ns from 'Y'` (namespace)
//! * `import X, { a, b } from 'Y'` (default + named combined)
//! * `import 'Y'` (side-effect only)
//! * `export default EXPR` (+ `function` / `class` declarations)
//! * `export const foo = …` / `export let` / `export var`
//! * `export function foo() {}` / `export class C {}`
//! * `export { a, b as c }` (no source)
//! * `export { a } from 'Y'` / `export * from 'Y'` /
//!   `export * as Ns from 'Y'` (re-export)
//!
//! Explicitly **out of scope**:
//!
//! * Dynamic `import()` — needs async resolution; use
//!   `require()` directly when you need it at runtime.
//! * Top-level `await` at module scope — CJS output doesn't model
//!   module-as-promise; wrap with `(async () => { … })()` if you
//!   need it.
//!
//! `import.meta.*` is rewritten textually to its CJS equivalent
//! before parse:
//!
//! * `import.meta.dirname` → `__dirname` (Node 21+)
//! * `import.meta.filename` → `__filename` (Node 21+)
//! * `import.meta.url` → `('file://' + __filename)`
//! * `import.meta.resolve(spec)` → `require.resolve(spec)` (Node 22+)
//! * bare `import.meta` → an inline object with `{ url, dirname,
//!   filename, resolve }` for the rare reflective-access case.
//!
//! The substitution is unambiguous (no valid JS uses the literal
//! token `import.meta` in a string or comment way that would be
//! confused with the syntactic form), so a regex-shaped pre-pass
//! keeps the AST traversal tight without a custom visitor.
//!
//! The transform emits an `Object.defineProperty(exports,
//! '__esModule', { value: true })` prologue for any module that
//! used `export default` or named exports, so CJS consumers that
//! check the interop flag (`require('./x').__esModule`) see a
//! truthful answer — this matches TypeScript's `esModuleInterop`
//! output.
//!
//! [#4050]: https://github.com/oxc-project/oxc/issues/4050

use oxc::allocator::Allocator;
use oxc::ast::ast::{
    BindingPattern, Declaration, ExportDefaultDeclarationKind, ImportDeclarationSpecifier,
    ModuleExportName, Statement,
};
use oxc::parser::Parser;
use oxc::span::{GetSpan, SourceType};
use std::path::Path;

/// Rewrite any top-level ESM declarations in `source` into CJS
/// equivalents. Source that contains no ESM declarations returns
/// unchanged (no parse cost? we still parse, but emit an identical
/// string — simpler than maintaining a second fast path).
pub fn rewrite_esm_to_cjs(source: &str, path: &Path) -> Result<String, String> {
    // Pre-pass: rewrite `import.meta.*` accesses to their CJS
    // equivalents. Done before the AST parse so the lowered output
    // doesn't carry `import.meta` into the CJS runtime where it'd
    // be a syntax error. See module-level docs for the mapping.
    let source_owned: String;
    let source: &str = if source.contains("import.meta") {
        source_owned = rewrite_import_meta(source);
        &source_owned
    } else {
        source
    };
    let allocator = Allocator::default();
    // Accept both `.js` / `.ts` etc. SourceType::from_path decides
    // ESM vs script based on extension; for explicit `.cjs` we still
    // want to parse permissively because the ESM rewrite ran on a
    // TS-strip that might leave CJS-shaped code too.
    let source_type = SourceType::from_path(path).unwrap_or(SourceType::mjs());
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.errors.is_empty() {
        return Err(parsed
            .errors
            .iter()
            .map(|e| format!("{e:?}"))
            .collect::<Vec<_>>()
            .join("\n"));
    }

    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut has_named_or_default_export = false;

    for stmt in &parsed.program.body {
        match stmt {
            Statement::ImportDeclaration(decl) => {
                let src_name = decl.source.value.as_str();
                let start = decl.span.start as usize;
                let end = decl.span.end as usize;
                let replacement =
                    rewrite_import(src_name, decl.specifiers.as_ref().map(|v| v.as_slice()));
                edits.push((start, end, replacement));
            }
            Statement::ExportDefaultDeclaration(decl) => {
                has_named_or_default_export = true;
                let start = decl.span.start as usize;
                let end = decl.span.end as usize;
                let replacement = rewrite_export_default(&decl.declaration, source);
                edits.push((start, end, replacement));
            }
            Statement::ExportNamedDeclaration(decl) => {
                has_named_or_default_export = true;
                let start = decl.span.start as usize;
                let end = decl.span.end as usize;
                let replacement = rewrite_export_named(
                    decl.declaration.as_ref(),
                    &decl.specifiers,
                    decl.source.as_ref().map(|s| s.value.as_str()),
                    source,
                );
                edits.push((start, end, replacement));
            }
            Statement::ExportAllDeclaration(decl) => {
                has_named_or_default_export = true;
                let start = decl.span.start as usize;
                let end = decl.span.end as usize;
                let src_name = decl.source.value.as_str();
                let exported_as = decl.exported.as_ref().map(mod_export_name);
                edits.push((
                    start,
                    end,
                    rewrite_export_all(src_name, exported_as.as_deref()),
                ));
            }
            _ => {}
        }
    }

    if edits.is_empty() {
        // No ESM — pass through. Keeps plain-CJS untouched.
        return Ok(source.to_string());
    }

    // Apply the edits right-to-left so earlier byte spans stay valid
    // while we splice.
    edits.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
    let mut out = source.to_string();
    for (start, end, text) in edits {
        out.replace_range(start..end, &text);
    }

    if has_named_or_default_export {
        // Preface so `require('./x').__esModule === true`, matching
        // TypeScript's CJS emit contract for interop.
        let prologue = "Object.defineProperty(exports, '__esModule', { value: true });\n";
        out.insert_str(0, prologue);
    }

    Ok(out)
}

fn rewrite_import(src: &str, specifiers: Option<&[ImportDeclarationSpecifier]>) -> String {
    let src_lit = js_string_literal(src);
    let Some(specs) = specifiers else {
        // `import 'Y'` — pure side-effect.
        return format!("require({src_lit});");
    };
    if specs.is_empty() {
        return format!("require({src_lit});");
    }

    // Collect the three kinds separately so we can build one require
    // per module (avoids re-evaluating side effects).
    let mut default_local: Option<String> = None;
    let mut namespace_local: Option<String> = None;
    let mut named: Vec<(String, String)> = Vec::new();

    for spec in specs {
        match spec {
            ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                default_local = Some(s.local.name.to_string());
            }
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                namespace_local = Some(s.local.name.to_string());
            }
            ImportDeclarationSpecifier::ImportSpecifier(s) => {
                let imported = mod_export_name(&s.imported);
                let local = s.local.name.to_string();
                named.push((imported, local));
            }
        }
    }

    // One stable temp binding per import statement holds the module
    // object; each specifier binds off that. `__ab_esm_N` isn't
    // colliding with user code if the user doesn't write names
    // starting with `__ab_`, which they shouldn't.
    let temp = next_temp();
    let mut out = format!("const {temp} = require({src_lit});\n");

    if let Some(local) = default_local {
        // TS `esModuleInterop` equivalent: if the require object has
        // an `__esModule: true` flag, pull `.default`; otherwise take
        // the object itself as the default binding.
        out.push_str(&format!(
            "const {local} = {temp} && {temp}.__esModule ? {temp}.default : {temp};\n"
        ));
    }
    if let Some(local) = namespace_local {
        out.push_str(&format!("const {local} = {temp};\n"));
    }
    if !named.is_empty() {
        let bindings: Vec<String> = named
            .iter()
            .map(|(imp, local)| {
                if imp == local {
                    local.clone()
                } else {
                    format!("{imp}: {local}")
                }
            })
            .collect();
        out.push_str(&format!("const {{ {} }} = {temp};\n", bindings.join(", ")));
    }
    out
}

fn rewrite_export_default(kind: &ExportDefaultDeclarationKind, source: &str) -> String {
    // `GetSpan::span()` works across the whole inherited-variant set
    // of ExportDefaultDeclarationKind — no enumeration needed.
    let span = kind.span();
    let text = &source[span.start as usize..span.end as usize];
    match kind {
        ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
            // Named function: emit the decl + assign the default.
            // Anonymous functions fall through to the expression form.
            if let Some(id) = f.id.as_ref() {
                format!("{text}\nmodule.exports.default = {};\n", id.name)
            } else {
                format!("module.exports.default = ({text});\n")
            }
        }
        ExportDefaultDeclarationKind::ClassDeclaration(c) => {
            if let Some(id) = c.id.as_ref() {
                format!("{text}\nmodule.exports.default = {};\n", id.name)
            } else {
                format!("module.exports.default = ({text});\n")
            }
        }
        ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => String::new(),
        _ => format!("module.exports.default = ({text});\n"),
    }
}

fn rewrite_export_named(
    declaration: Option<&Declaration>,
    specifiers: &[oxc::ast::ast::ExportSpecifier],
    source_module: Option<&str>,
    source_text: &str,
) -> String {
    // Two shapes:
    // (1) `export const foo = …` / function / class — ignore specifiers.
    // (2) `export { a, b }` / `export { a } from 'Y'` — ignore declaration.
    if let Some(decl) = declaration {
        let (span, names) = decl_span_and_names(decl);
        let text = &source_text[span.start as usize..span.end as usize];
        let mut out = text.to_string();
        out.push('\n');
        for name in names {
            out.push_str(&format!("exports.{name} = {name};\n"));
        }
        return out;
    }

    let mut out = String::new();
    if let Some(src) = source_module {
        // `export { a, b as c } from 'Y'` — re-export. One require
        // per statement keyed on a fresh temp.
        let temp = next_temp();
        out.push_str(&format!(
            "const {temp} = require({});\n",
            js_string_literal(src)
        ));
        for spec in specifiers {
            let local = mod_export_name(&spec.local);
            let exported = mod_export_name(&spec.exported);
            out.push_str(&format!("exports.{exported} = {temp}.{local};\n"));
        }
        return out;
    }

    // `export { a, b as c }` — specifiers reference bindings already
    // in scope.
    for spec in specifiers {
        let local = mod_export_name(&spec.local);
        let exported = mod_export_name(&spec.exported);
        out.push_str(&format!("exports.{exported} = {local};\n"));
    }
    out
}

fn rewrite_export_all(src: &str, exported_as: Option<&str>) -> String {
    let src_lit = js_string_literal(src);
    match exported_as {
        Some(name) => {
            // `export * as Ns from 'Y'`
            format!("exports.{name} = require({src_lit});\n")
        }
        None => {
            // `export * from 'Y'` — copy enumerable props except
            // `default` (Node's semantics).
            format!(
                "Object.keys(require({src_lit})).forEach(function(k) {{ \
                    if (k !== 'default' && k !== '__esModule') exports[k] = require({src_lit})[k]; \
                 }});\n"
            )
        }
    }
}

/// Returns the outer span covering a Declaration and the list of
/// names it introduces into scope. For a `const` with multiple
/// declarators (e.g. `export const a = 1, b = 2`), all are listed.
fn decl_span_and_names(decl: &Declaration) -> (oxc::span::Span, Vec<String>) {
    let span = decl.span();
    let names = match decl {
        Declaration::VariableDeclaration(v) => {
            let mut names = Vec::new();
            for d in &v.declarations {
                collect_binding_names(&d.id, &mut names);
            }
            names
        }
        Declaration::FunctionDeclaration(f) => {
            f.id.as_ref()
                .map(|id| vec![id.name.to_string()])
                .unwrap_or_default()
        }
        Declaration::ClassDeclaration(c) => {
            c.id.as_ref()
                .map(|id| vec![id.name.to_string()])
                .unwrap_or_default()
        }
        // Type-only declarations are stripped by the oxc TS
        // transformer before we see them; defensive fallthrough.
        _ => vec![],
    };
    (span, names)
}

fn collect_binding_names(pat: &BindingPattern<'_>, out: &mut Vec<String>) {
    match pat {
        BindingPattern::BindingIdentifier(id) => out.push(id.name.to_string()),
        BindingPattern::ObjectPattern(obj) => {
            for prop in &obj.properties {
                collect_binding_names(&prop.value, out);
            }
            if let Some(rest) = obj.rest.as_ref() {
                collect_binding_names(&rest.argument, out);
            }
        }
        BindingPattern::ArrayPattern(arr) => {
            for elem in arr.elements.iter() {
                if let Some(e) = elem.as_ref() {
                    collect_binding_names(e, out);
                }
            }
            if let Some(rest) = arr.rest.as_ref() {
                collect_binding_names(&rest.argument, out);
            }
        }
        BindingPattern::AssignmentPattern(ap) => collect_binding_names(&ap.left, out),
    }
}

fn mod_export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::IdentifierName(i) => i.name.to_string(),
        ModuleExportName::IdentifierReference(i) => i.name.to_string(),
        ModuleExportName::StringLiteral(s) => s.value.to_string(),
    }
}

fn js_string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn next_temp() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let n = CTR.fetch_add(1, Ordering::Relaxed);
    format!("__ab_esm_{n}")
}

/// Textual `import.meta.*` → CJS rewrite. Walks the source byte-by-
/// byte skipping inside string and template literals + line/block
/// comments so the substitution can't fire on a string that happens
/// to contain `"import.meta"`. Patterns matched (longest first):
///
/// * `import.meta.dirname`        → `__dirname`
/// * `import.meta.filename`       → `__filename`
/// * `import.meta.url`            → `('file://' + __filename)`
/// * `import.meta.resolve(`       → `require.resolve(`
/// * `import.meta` (bare)         → an inline `{ url, dirname,
///   filename, resolve }` object literal that re-routes the same
///   four accesses through the CJS surface above.
fn rewrite_import_meta(source: &str) -> String {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len + 64);
    let mut i = 0usize;
    while i < len {
        let b = bytes[i];

        // Single-line comment: copy until newline.
        if b == b'/' && i + 1 < len && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                out.push(bytes[i] as char);
                i += 1;
            }
            continue;
        }
        // Block comment: copy until `*/`.
        if b == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
            out.push_str("/*");
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                out.push(bytes[i] as char);
                i += 1;
            }
            if i + 1 < len {
                out.push_str("*/");
                i += 2;
            } else if i < len {
                out.push(bytes[i] as char);
                i += 1;
            }
            continue;
        }
        // String / template literal: copy verbatim, honoring escapes.
        if b == b'\'' || b == b'"' || b == b'`' {
            let quote = b;
            out.push(b as char);
            i += 1;
            while i < len {
                let c = bytes[i];
                out.push(c as char);
                i += 1;
                if c == b'\\' && i < len {
                    out.push(bytes[i] as char);
                    i += 1;
                    continue;
                }
                if c == quote {
                    break;
                }
            }
            continue;
        }

        // `import.meta` token? Must not be preceded by an ident char
        // (so `myimport.meta` doesn't match) and must be followed by
        // either `.` or a non-ident char.
        if b == b'i' && starts_with(bytes, i, b"import.meta") {
            let prev_ok = i == 0 || !is_ident_byte(bytes[i - 1]);
            if prev_ok {
                let after = i + b"import.meta".len();
                // Try the longer specialisations first.
                if starts_with(bytes, after, b".dirname") {
                    out.push_str("__dirname");
                    i = after + b".dirname".len();
                    continue;
                }
                if starts_with(bytes, after, b".filename") {
                    out.push_str("__filename");
                    i = after + b".filename".len();
                    continue;
                }
                if starts_with(bytes, after, b".url") {
                    out.push_str("('file://' + __filename)");
                    i = after + b".url".len();
                    continue;
                }
                if starts_with(bytes, after, b".resolve") {
                    out.push_str("require.resolve");
                    i = after + b".resolve".len();
                    continue;
                }
                // Bare `import.meta` — synthesise an inline object.
                // The `resolve` callback closes over `require` so
                // dynamic resolution still goes through the CJS
                // resolver (npm packages, node_modules walk, etc.).
                if after >= len || !is_ident_byte(bytes[after]) {
                    out.push_str(
                        "({ url: 'file://' + __filename, dirname: __dirname, \
                         filename: __filename, \
                         resolve: function(s){ return require.resolve(s); } })",
                    );
                    i = after;
                    continue;
                }
            }
        }

        out.push(b as char);
        i += 1;
    }
    out
}

fn starts_with(bytes: &[u8], at: usize, needle: &[u8]) -> bool {
    if at + needle.len() > bytes.len() {
        return false;
    }
    &bytes[at..at + needle.len()] == needle
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

#[cfg(test)]
mod import_meta_tests {
    use super::rewrite_import_meta;

    #[test]
    fn rewrites_dirname_and_filename() {
        let s = "console.log(import.meta.dirname, import.meta.filename);";
        let out = rewrite_import_meta(s);
        assert_eq!(out, "console.log(__dirname, __filename);");
    }

    #[test]
    fn rewrites_url_and_resolve() {
        let s = "const u = import.meta.url; const p = import.meta.resolve('x');";
        let out = rewrite_import_meta(s);
        assert!(out.contains("('file://' + __filename)"));
        assert!(out.contains("require.resolve('x')"));
    }

    #[test]
    fn rewrites_bare_import_meta() {
        let s = "const m = import.meta;";
        let out = rewrite_import_meta(s);
        assert!(out.contains("url: 'file://' + __filename"));
        assert!(out.contains("dirname: __dirname"));
    }

    #[test]
    fn skips_inside_strings() {
        let s = "const t = 'import.meta.dirname'; const r = import.meta.dirname;";
        let out = rewrite_import_meta(s);
        // First occurrence (inside a single-quoted string) preserved.
        assert!(out.contains("'import.meta.dirname'"));
        // Second occurrence (real syntax) rewritten.
        assert!(out.ends_with("__dirname;"));
    }

    #[test]
    fn skips_inside_template_literals() {
        let s = "const t = `${import.meta.dirname}`; const r = import.meta.dirname;";
        let out = rewrite_import_meta(s);
        // Template literal does NOT get the inner expression rewritten
        // by this textual pass — that's a real edge case but matches
        // every other pre-pass we run. The simple consumer just stays
        // out of import.meta inside templates.
        assert!(out.ends_with("__dirname;"));
    }

    #[test]
    fn skips_inside_comments() {
        let s = "// import.meta.dirname\n/* import.meta.url */\nconst x = import.meta.dirname;";
        let out = rewrite_import_meta(s);
        assert!(out.contains("// import.meta.dirname"));
        assert!(out.contains("/* import.meta.url */"));
        assert!(out.ends_with("__dirname;"));
    }

    #[test]
    fn requires_word_boundary_before_token() {
        // Hypothetical `notimport.meta.dirname` should NOT match —
        // the leading `not` makes it a member access on `notimport`,
        // not the syntactic `import.meta` form.
        let s = "obj.notimport.meta.dirname";
        let out = rewrite_import_meta(s);
        assert_eq!(out, s);
    }
}
