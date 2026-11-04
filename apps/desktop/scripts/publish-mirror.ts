/** Upload immutable installers first, verify on the VPS, then replace metadata. */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "./verify-release.ts";
const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/publish-mirror.ts release-feed-directory [candidate-directory]");
await verifyRelease(directory, process.argv[3] ?? fileURLToPath(new URL("../release", import.meta.url)));
const names = readdirSync(directory);
if (!names.length || names.some(name => !/^[A-Za-z0-9][A-Za-z0-9._-]+\.(json|yml|dmg|exe)$/.test(name))) throw new Error("Release feed contains unexpected files");
const host = process.env.MOUNTAINS_UPDATE_SSH ?? "mindone-vps";
if (!/^[A-Za-z0-9_.-]+$/.test(host)) throw new Error("Use an SSH config host alias");
const stage = `/srv/mountains-updates-staging/${Date.now()}`;
function run(args: string[]) { const result = spawnSync(args[0]!, args.slice(1), { stdio: "inherit" }); if (result.status !== 0) throw new Error(`${args[0]} failed`); }
run(["ssh", host, `install -d -m 700 ${stage}`]);
run(["scp", ...names.map(name => join(directory, name)), `${host}:${stage}/`]);
const program = `
import fcntl, hashlib, json, os, shutil
from pathlib import Path
source=Path(${JSON.stringify(stage)})
target=Path('/srv/mountains-updates/desktop')
target.mkdir(parents=True,exist_ok=True)
with open('/srv/mountains-updates-staging/publish.lock','w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 catalogs=list(source.glob('*.json'))
 if not catalogs:raise RuntimeError('No release catalog')
 artifacts=set()
 for catalog in catalogs:
  data=json.loads(catalog.read_text());name=data['file'];path=source/name
  if name!=Path(name).name or path.stat().st_size!=data['size']:raise RuntimeError('Invalid artifact')
  digest=hashlib.file_digest(path.open('rb'),'sha512').digest()
  import base64
  if base64.b64encode(digest).decode()!=data['sha512']:raise RuntimeError('Upload checksum mismatch')
  dest=target/name
  if dest.exists() and hashlib.file_digest(dest.open('rb'),'sha512').digest()!=digest:raise RuntimeError('Immutable release filename already exists')
  artifacts.add(name)
 for name in artifacts:
  path=source/name;path.chmod(0o644);os.replace(path,target/name)
 for path in list(source.glob('*.yml'))+catalogs:
  path.chmod(0o644);os.replace(path,target/path.name)
 shutil.rmtree(source)
 print('Published',len(catalogs),'catalogs after verifying every installer')
`;
const result = spawnSync("ssh", [host, "python3 -"], { input: program, stdio: ["pipe", "inherit", "inherit"] });
if (result.status !== 0) throw new Error("Mirror verification/publish failed; live metadata was not intentionally replaced");
