import { customAlphabet } from 'nanoid';

/** Unambiguous alphabet: no 0/O, 1/l/I — ids get read aloud and retyped. */
const ID_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const ID_LENGTH = 8;

const generateId = customAlphabet(ID_ALPHABET, ID_LENGTH);

export function newPasteId(): string {
  return generateId();
}

/** 32 random bytes as 64 lowercase hex chars; only its SHA-256 is persisted. */
export function newDeleteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
