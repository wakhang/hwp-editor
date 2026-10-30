import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    dir = parent;
  }
  return dir;
}
const root = findRoot();
const bundledJava = join(root, 'vendor/jdk/Contents/Home/bin/java');

async function paths(): Promise<{ java: string; jar: string }> {
  let java = process.env.HWPED_JAVA;
  if (!java) {
    try {
      await access(bundledJava, constants.X_OK);
      java = bundledJava;
    } catch {
      java = 'java';
    }
  }
  return { java, jar: process.env.HWPED_JAR || join(root, 'vendor/hwp2hwpx-cli.jar') };
}

export async function converterAvailable(): Promise<{ ok: boolean; reason?: string }> {
  const { java, jar } = await paths();
  try {
    await access(jar, constants.R_OK);
    await exec(java, ['-version'], { timeout: 60_000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function convertHwpToHwpx(hwpPath: string): Promise<Uint8Array> {
  const { java, jar } = await paths();
  const dir = await mkdtemp(join(tmpdir(), 'hwped-convert-'));
  try {
    const output = join(dir, 'output.hwpx');
    try {
      await exec(java, ['-jar', jar, resolve(hwpPath), output], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
      throw new Error(`HWP conversion failed: ${stderr || (error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
