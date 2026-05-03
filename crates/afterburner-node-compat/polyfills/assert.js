// assert — subset. Deep-equality is structural; follows the Node.js
// "strict" semantics (=== for primitives, shape-recursive for objects).

__register_module('assert', function(module, exports, require) {

    function AssertionError(opts) {
        var message = opts && opts.message;
        if (!message) {
            var act = safeStringify(opts && opts.actual);
            var exp = safeStringify(opts && opts.expected);
            var op  = (opts && opts.operator) || 'fail';
            message = act + ' ' + op + ' ' + exp;
        }
        var err = new Error(message);
        err.name = 'AssertionError';
        err.actual = opts && opts.actual;
        err.expected = opts && opts.expected;
        err.operator = opts && opts.operator;
        err.generatedMessage = !(opts && opts.message);
        err.code = 'ERR_ASSERTION';
        return err;
    }

    function safeStringify(v) {
        try { return JSON.stringify(v); } catch (_) { return String(v); }
    }

    function deepEqual(a, b, strict) {
        if (strict ? a === b : a == b) return true;
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
            return false;
        }
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        var ka = Object.keys(a);
        var kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var i = 0; i < ka.length; i++) {
            var k = ka[i];
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (!deepEqual(a[k], b[k], strict)) return false;
        }
        return true;
    }

    function assertFn(value, message) {
        if (!value) throw AssertionError({ actual: value, expected: true, operator: '==', message: message });
    }

    assertFn.ok = assertFn;
    assertFn.fail = function(message) {
        throw AssertionError({ message: message || 'Failed' });
    };
    assertFn.equal = function(a, e, m) {
        if (a != e) throw AssertionError({ actual: a, expected: e, operator: '==', message: m });
    };
    assertFn.notEqual = function(a, e, m) {
        if (a == e) throw AssertionError({ actual: a, expected: e, operator: '!=', message: m });
    };
    assertFn.strictEqual = function(a, e, m) {
        if (a !== e) throw AssertionError({ actual: a, expected: e, operator: '===', message: m });
    };
    assertFn.notStrictEqual = function(a, e, m) {
        if (a === e) throw AssertionError({ actual: a, expected: e, operator: '!==', message: m });
    };
    assertFn.deepEqual = function(a, e, m) {
        if (!deepEqual(a, e, false)) throw AssertionError({ actual: a, expected: e, operator: 'deepEqual', message: m });
    };
    assertFn.deepStrictEqual = function(a, e, m) {
        if (!deepEqual(a, e, true)) throw AssertionError({ actual: a, expected: e, operator: 'deepStrictEqual', message: m });
    };
    assertFn.throws = function(fn, expected, message) {
        var threw = false;
        var err;
        try { fn(); } catch (e) { threw = true; err = e; }
        if (!threw) throw AssertionError({ message: message || 'Expected function to throw' });
        if (expected instanceof RegExp && !expected.test(String(err))) {
            throw AssertionError({ actual: err, expected: expected, operator: 'throws', message: message });
        }
    };
    assertFn.doesNotThrow = function(fn, message) {
        try { fn(); } catch (e) {
            throw AssertionError({ actual: e, operator: 'doesNotThrow', message: message || 'Unexpected throw' });
        }
    };
    assertFn.AssertionError = AssertionError;
    assertFn.strict = assertFn;

    module.exports = assertFn;
});
