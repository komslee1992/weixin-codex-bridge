import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sdkPath = path.join(root, "node_modules", "weixin-agent-sdk", "dist", "index.mjs");

if (!fs.existsSync(sdkPath)) {
  console.warn(`[patch-weixin-sdk] skipped; not found: ${sdkPath}`);
  process.exit(0);
}

let source = fs.readFileSync(sdkPath, "utf8");
const results = [];

function replacePatch(label, before, after) {
  if (source.includes(after)) {
    results.push(`${label}: already patched`);
    return;
  }

  if (!source.includes(before)) {
    results.push(`${label}: missing target`);
    return;
  }

  source = source.replace(before, after);
  results.push(`${label}: patched`);
}

replacePatch(
  "disable-sdk-slash-commands",
  'if (textBody.startsWith("/")) {',
  'if (process.env.WEIXIN_BRIDGE_DISABLE_SLASH !== "1" && textBody.startsWith("/")) {',
);

replacePatch(
  "print-qr-login-url",
  'if (!startResult.qrcodeUrl) throw new Error(startResult.message);\n\tlog("\\n使用微信扫描以下二维码，以完成连接：\\n");',
  'if (!startResult.qrcodeUrl) throw new Error(startResult.message);\n\tlog(`二维码链接: ${startResult.qrcodeUrl}`);\n\tlog("\\n使用微信扫描以下二维码，以完成连接：\\n");',
);

const missing = results.filter((result) => result.endsWith(": missing target"));
if (missing.length) {
  console.error(`[patch-weixin-sdk] failed: ${missing.join("; ")}`);
  process.exit(1);
}

fs.writeFileSync(sdkPath, source, "utf8");
console.log(`[patch-weixin-sdk] ok: ${results.join("; ")}`);
