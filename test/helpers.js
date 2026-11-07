"use strict";
// 极简测试基建（零依赖）：node test/run.js 串行执行 test/*.test.js
const results = [];
let currentFile = "";

function test(name, fn) {
  try {
    fn();
    results.push({ file: currentFile, name, pass: true });
  } catch (e) {
    results.push({ file: currentFile, name, pass: false, error: e.message });
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "断言失败"}：实际 ${a}，期望 ${e}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || "断言失败");
}

function approx(actual, expected, msg) {
  if (typeof actual !== "number" || Math.abs(actual - expected) > 0.01) {
    throw new Error(`${msg || "近似断言失败"}：实际 ${actual}，期望 ≈${expected}`);
  }
}

function setFile(f) { currentFile = f; }

function summary() {
  const fails = results.filter((r) => !r.pass);
  results.forEach((r) => {
    console.log(`${r.pass ? "✓" : "✗"} [${r.file}] ${r.name}${r.pass ? "" : " — " + r.error}`);
  });
  console.log(`\n${results.length - fails.length}/${results.length} 通过`);
  return fails.length;
}

module.exports = { test, eq, ok, approx, setFile, summary };
