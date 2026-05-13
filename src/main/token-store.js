import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

const FILE_NAME = 'auth.bin';

function authPath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function legacyAuthPath() {
  return path.join(app.getPath('appData'), 'gitcp', FILE_NAME);
}

export function loadToken() {
  const paths = [authPath(), legacyAuthPath()];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p);
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const decrypted = safeStorage.decryptString(raw);
        return JSON.parse(decrypted);
      }
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

export function saveToken(data) {
  const p = authPath();
  const json = JSON.stringify(data);
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, payload);
}

export function clearToken() {
  for (const p of [authPath(), legacyAuthPath()]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
