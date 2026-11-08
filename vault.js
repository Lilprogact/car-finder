// Password lock and token vault.
//
// What this protects: your GitHub token, stored on this device only, encrypted with a key
// derived from your password (PBKDF2-SHA256, 600,000 rounds, random salt; AES-256-GCM).
// The site shows nothing and calls nothing until the password has been entered.
//
// What it can't do: GitHub Pages is a static host, so there is no server-side login. Anyone
// can read this site's code (it's a public repo), but without the token on your device the
// site has nothing to show and nothing to run. The token is the real key; the password keeps
// it safe on a device someone else might pick up.

const VAULT_KEY = "cf.vault.v1";
const SESSION_KEY = "cf.session.v1";
const VERIFIER = "car-finder-ok";
const ITERATIONS = 600000;
const IDLE_MINUTES = 30;

let cryptoKey = null;
let cachedToken = null;
let idleTimer = null;
let onLockCallback = null;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function unb64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
function readVault() {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeVault(data) {
  localStorage.setItem(VAULT_KEY, JSON.stringify(data));
}

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}
async function encrypt(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decrypt(key, blob) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct));
  return dec.decode(plain);
}

function touchIdle() {
  if (!cryptoKey) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => lock("idle"), IDLE_MINUTES * 60 * 1000);
}

export function supported() {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof localStorage !== "undefined";
}

export function state() {
  const vault = readVault();
  if (!vault) return "no_password";
  return cryptoKey ? "unlocked" : "locked";
}

export function hasToken() {
  const vault = readVault();
  return !!(vault && vault.token);
}

export function tokenMeta() {
  const vault = readVault() || {};
  return { expiresAt: vault.tokenExpiresAt || null, owner: vault.owner || null, savedAt: vault.tokenSavedAt || null };
}

export function onLock(callback) {
  onLockCallback = callback;
}

export async function setPassword(password) {
  if (!password || password.length < 6) throw new Error("Use at least 6 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, ITERATIONS);
  const verifier = await encrypt(key, VERIFIER);
  writeVault({ version: 1, salt: b64(salt), iterations: ITERATIONS, verifier });
  cryptoKey = key;
  cachedToken = null;
  await rememberSession(key);
  touchIdle();
}

async function rememberSession(key) {
  try {
    const raw = await crypto.subtle.exportKey("raw", key);
    sessionStorage.setItem(SESSION_KEY, b64(raw));
  } catch {
    /* session memory is a convenience only */
  }
}

export async function unlock(password) {
  const vault = readVault();
  if (!vault) throw new Error("No password set yet.");
  const key = await deriveKey(password, unb64(vault.salt), vault.iterations || ITERATIONS);
  let check;
  try {
    check = await decrypt(key, vault.verifier);
  } catch {
    throw new Error("That password doesn't match.");
  }
  if (check !== VERIFIER) throw new Error("That password doesn't match.");
  cryptoKey = key;
  cachedToken = null;
  await rememberSession(key);
  touchIdle();
  return true;
}

export async function resumeSession() {
  if (cryptoKey) return true;
  const vault = readVault();
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!vault || !raw) return false;
  try {
    const key = await crypto.subtle.importKey("raw", unb64(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
    if ((await decrypt(key, vault.verifier)) !== VERIFIER) return false;
    cryptoKey = key;
    touchIdle();
    return true;
  } catch {
    return false;
  }
}

export function lock(reason = "manual") {
  cryptoKey = null;
  cachedToken = null;
  clearTimeout(idleTimer);
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  if (onLockCallback) onLockCallback(reason);
}

export async function getToken() {
  if (!cryptoKey) throw new Error("Locked.");
  if (cachedToken) return cachedToken;
  const vault = readVault();
  if (!vault || !vault.token) return null;
  cachedToken = await decrypt(cryptoKey, vault.token);
  return cachedToken;
}

export async function setToken(token, meta = {}) {
  if (!cryptoKey) throw new Error("Unlock first.");
  const clean = String(token || "").trim();
  if (!clean) throw new Error("Paste a token first.");
  const vault = readVault();
  vault.token = await encrypt(cryptoKey, clean);
  vault.tokenSavedAt = new Date().toISOString();
  vault.tokenExpiresAt = meta.expiresAt || null;
  vault.owner = meta.owner || null;
  writeVault(vault);
  cachedToken = clean;
}

export function setTokenMeta(meta) {
  const vault = readVault();
  if (!vault) return;
  if (meta.expiresAt !== undefined) vault.tokenExpiresAt = meta.expiresAt;
  if (meta.owner !== undefined) vault.owner = meta.owner;
  writeVault(vault);
}

export function forgetToken() {
  const vault = readVault();
  if (!vault) return;
  delete vault.token;
  delete vault.tokenSavedAt;
  delete vault.tokenExpiresAt;
  delete vault.owner;
  writeVault(vault);
  cachedToken = null;
}

export async function changePassword(oldPassword, newPassword) {
  await unlock(oldPassword);
  const token = await getToken();
  const meta = tokenMeta();
  await setPassword(newPassword);
  if (token) await setToken(token, { expiresAt: meta.expiresAt, owner: meta.owner });
}

export function resetDevice() {
  lock("reset");
  localStorage.removeItem(VAULT_KEY);
}

export function noteActivity() {
  touchIdle();
}
