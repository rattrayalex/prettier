"use strict";
exports.__esModule = true;
var always = require("./always");
var RAW = Symbol["for"]('jest-snapshot-serializer-raw');
function wrap(value) {
    var _a;
    return _a = {}, _a[RAW] = value, _a;
}
exports.wrap = wrap;
function test(value) {
    return value && always.test(value[RAW]);
}
exports.test = test;
function print(value) {
    return always.print(value[RAW]);
}
exports.print = print;
exports["default"] = wrap;
