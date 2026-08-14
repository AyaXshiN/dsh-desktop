'use strict';

/**
 * 只读探查 E:\ClaudeCodeHaha\Claude Code Haha\resources\app.asar 的桌面壳实现，
 * 把匹配的 shell 文件提取到本工作区的 .asar-peek/（不修改 E: 盘任何文件）。
 *
 * 用法: node scripts/asar-peek.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ASAR_PATH = 'E:\\ClaudeCodeHaha\\Claude Code Haha\\resources\\app.asar';
const OUT_DIR = path.resolve(__dirname, '..', '.asar-peek');
const INTEREST = /(^|\/)(main|preload|electron|desktop|tray|window|updater|menu|shell|shortcut|ipc|native|autostart|protocol|deep-?link)/i;

const fd = fs.openSync(ASAR_PATH, 'r');
try {
  const headerBuf = Buffer.alloc(16);
  fs.readSync(fd, headerBuf, 0, 16, 0);
  // asar 头部: [0..3]=4, [4..7]=headerSize, [8..11]=headerSize+jsonSize, [12..15]=jsonSize
  const headerSize = headerBuf.readUInt32LE(4);
  const jsonSize = headerBuf.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonSize);
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  const index = JSON.parse(jsonBuf.toString('utf8'));
  const baseOffset = 16 + headerSize;

  const hits = [];
  (function walk(node, prefix) {
    if (!node.files) return;
    for (const [name, entry] of Object.entries(node.files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, p);
      else if (INTEREST.test(p)) hits.push({ p, size: entry.size, offset: entry.offset });
    }
  })(index, '');

  console.log(`命中 ${hits.length} 个 shell 相关文件（共 ${Object.keys(index.files || {}).length} 个顶层项）`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = [];
  for (const h of hits.slice(0, 60)) {
    const target = path.join(OUT_DIR, h.p.replace(/\//g, '__'));
    const buf = Buffer.alloc(h.size);
    fs.readSync(fd, buf, 0, h.size, baseOffset + Number(h.offset));
    fs.writeFileSync(target, buf);
    manifest.push({ asarPath: h.p, size: h.size, extractedTo: target });
    console.log(`${h.size.toString().padStart(10)}  ${h.p}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n提取完成 -> ${OUT_DIR}`);

  // 第二阶段：壳自身代码（dist / electron-dist / src-tauri / package.json）
  console.log('\n===== 第二阶段：壳自身文件 =====');
  const shellHits = [];
  (function walkShell(node, prefix) {
    if (!node.files) return;
    for (const [name, entry] of Object.entries(node.files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walkShell(entry, p);
      else if (/^(dist|electron-dist|src-tauri)(\/|$)/.test(p) || p === 'package.json') {
        if (entry.unpacked || entry.offset === undefined) continue;
        if (entry.size < 5 * 1024 * 1024) shellHits.push({ p, size: entry.size, offset: entry.offset });
      }
    }
  })(index, '');
  console.log(`壳相关文件 ${shellHits.length} 个`);
  for (const h of shellHits.slice(0, 120)) {
    const target = path.join(OUT_DIR, 'shell', h.p.replace(/\//g, '__'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const buf = Buffer.alloc(h.size);
    fs.readSync(fd, buf, 0, h.size, baseOffset + Number(h.offset));
    fs.writeFileSync(target, buf);
    console.log(`${h.size.toString().padStart(9)}  ${h.p}`);
  }
} finally {
  fs.closeSync(fd);
}
