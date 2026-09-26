/**
 * web/assets/photos 配下を走査し index.json を生成する。
 * 使い方: node scripts/index-photos.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PHOTO_FILE_PATTERN = /\.(jpe?g|png|gif|webp|svg|bmp)$/i;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photosRoot = path.resolve(__dirname, "../web/assets/photos");
const indexPath = path.join(photosRoot, "index.json");

function listPhotoFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PHOTO_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "ja"));
}

function walkFolders(root) {
  const folders = {};
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
    return folders;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const folderPath = path.join(root, entry.name);
    const files = listPhotoFiles(folderPath);
    if (files.length > 0) {
      folders[entry.name] = files;
    }
  }
  return folders;
}

const folders = walkFolders(photosRoot);
fs.writeFileSync(indexPath, JSON.stringify(folders, null, 2) + "\n", "utf8");
console.log(
  "Wrote",
  path.relative(process.cwd(), indexPath),
  `(${Object.keys(folders).length} folders)`
);
