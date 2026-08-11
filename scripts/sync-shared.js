#!/usr/bin/env node
/**
 * 将 cloudfunctions/_shared 下的公共模块同步到每个云函数目录。
 * 云函数独立部署，每个函数必须自包含，修改 _shared 后运行：
 *   npm run sync:shared
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "cloudfunctions");
const sharedDir = path.join(root, "_shared");
const files = fs.readdirSync(sharedDir).filter(f => f.endsWith(".js"));
// 只同步 cloudbaserc.json 里已注册的云函数，避免把已下线函数目录再带上
const cloudbaserc = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cloudbaserc.json"), "utf-8"));
const registered = new Set((cloudbaserc.functions || []).map(f => f.name));
const targets = fs.readdirSync(root).filter(name => {
  const full = path.join(root, name);
  return fs.statSync(full).isDirectory() && name !== "_shared" && registered.has(name);
});

let copied = 0;
for (const target of targets) {
  const destDir = path.join(root, target, "_shared");
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of files) {
    fs.copyFileSync(path.join(sharedDir, file), path.join(destDir, file));
    copied++;
  }
}

console.log(`[sync-shared] 已同步 ${copied} 个文件到 ${targets.length} 个云函数`);
