import { env } from 'cloudflare:workers';
import { isExpirationOption } from './expiry';
import type { CreateInput, ExpirationOption, Visibility } from './types';

export interface LanguageDef {
  id: string;
  label: string;
  ext: string;
  shiki: string | null;
}

export const LANGUAGES: readonly LanguageDef[] = [
  { id: 'plaintext', label: 'Plain text', ext: 'txt', shiki: null },
  { id: 'javascript', label: 'JavaScript', ext: 'js', shiki: 'javascript' },
  { id: 'typescript', label: 'TypeScript', ext: 'ts', shiki: 'typescript' },
  { id: 'jsx', label: 'JSX', ext: 'jsx', shiki: 'jsx' },
  { id: 'tsx', label: 'TSX', ext: 'tsx', shiki: 'tsx' },
  { id: 'python', label: 'Python', ext: 'py', shiki: 'python' },
  { id: 'go', label: 'Go', ext: 'go', shiki: 'go' },
  { id: 'rust', label: 'Rust', ext: 'rs', shiki: 'rust' },
  { id: 'json', label: 'JSON', ext: 'json', shiki: 'json' },
  { id: 'yaml', label: 'YAML', ext: 'yml', shiki: 'yaml' },
  { id: 'toml', label: 'TOML', ext: 'toml', shiki: 'toml' },
  { id: 'markdown', label: 'Markdown', ext: 'md', shiki: 'markdown' },
  { id: 'html', label: 'HTML', ext: 'html', shiki: 'html' },
  { id: 'css', label: 'CSS', ext: 'css', shiki: 'css' },
  { id: 'sql', label: 'SQL', ext: 'sql', shiki: 'sql' },
  { id: 'bash', label: 'Bash', ext: 'sh', shiki: 'bash' },
] as const;

const LANGUAGE_BY_ID = new Map(LANGUAGES.map((lang) => [lang.id, lang]));

const DEFAULT_MAX_PASTE_BYTES = 10_485_760;
const MAX_TITLE_LENGTH = 200;
const MAX_PASSWORD_LENGTH = 256;

/**
 * Slack allowed on top of the content cap when rejecting purely on
 * `Content-Length`: multipart boundaries, part headers and the other form
 * fields all ride along in the same body.
 */
const REQUEST_OVERHEAD_BYTES = 65_536;

const encoder = new TextEncoder();

export function isLanguage(id: string): boolean {
  return LANGUAGE_BY_ID.has(id);
}

export function extFor(language: string): string {
  return LANGUAGE_BY_ID.get(language)?.ext ?? 'txt';
}

export function maxPasteBytes(): number {
  const parsed = Number.parseInt(env.MAX_PASTE_BYTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PASTE_BYTES;
}

type ParseFailure = { ok: false; status: number; error: string };

type ParseSuccess = {
  ok: true;
  input: CreateInput;
  sizeBytes: number;
  lineCount: number;
};

function fail(status: number, error: string): ParseFailure {
  return { ok: false, status, error };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Form encodings have no booleans: `true` / `1` / `on` are the truthy wire values. */
function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'on';
}

function isFileLike(value: unknown): value is { text: () => Promise<string> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { text?: unknown }).text === 'function'
  );
}

function countLines(content: string): number {
  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

async function readFields(
  request: Request,
  contentType: string,
): Promise<Record<string, unknown> | ParseFailure> {
  if (contentType.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return fail(400, 'invalid_json');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail(400, 'invalid_body');
    }
    return parsed as Record<string, unknown>;
  }

  if (
    contentType.includes('multipart/form-data') ||
    contentType.includes('application/x-www-form-urlencoded')
  ) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, 'invalid_form');
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (!(key in fields)) fields[key] = value;
    }
    return fields;
  }

  return fail(400, 'unsupported_content_type');
}

export async function parseCreateRequest(
  request: Request,
): Promise<ParseSuccess | ParseFailure> {
  const cap = maxPasteBytes();

  // Reject obvious oversize before buffering the body at all.
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const declared = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(declared) && declared > cap + REQUEST_OVERHEAD_BYTES) {
      return fail(413, 'too_large');
    }
  }

  const contentType = (request.headers.get('Content-Type') ?? '').toLowerCase();
  const fields = await readFields(request, contentType);
  if ('ok' in fields && fields.ok === false) return fields as ParseFailure;
  const raw = fields as Record<string, unknown>;

  let content = asString(raw['content']);
  if (content === null || content.length === 0) {
    const filePart = raw['file'];
    if (isFileLike(filePart)) {
      try {
        content = await filePart.text();
      } catch {
        return fail(400, 'invalid_file');
      }
    }
  }
  if (content === null || content.length === 0) return fail(400, 'content_required');

  const sizeBytes = encoder.encode(content).length;
  if (sizeBytes > cap) return fail(413, 'too_large');

  const languageRaw = (asString(raw['language']) ?? '').trim();
  const language = languageRaw === '' ? 'plaintext' : languageRaw;
  if (!isLanguage(language)) return fail(400, 'invalid_language');

  const titleRaw = (asString(raw['title']) ?? '').trim();
  if (titleRaw.length > MAX_TITLE_LENGTH) return fail(400, 'title_too_long');
  const title = titleRaw === '' ? null : titleRaw;

  const expirationRaw = (asString(raw['expiration']) ?? '').trim();
  const expirationCandidate = expirationRaw === '' ? 'never' : expirationRaw;
  if (!isExpirationOption(expirationCandidate)) return fail(400, 'invalid_expiration');
  const expiration: ExpirationOption = expirationCandidate;

  const visibilityRaw = (asString(raw['visibility']) ?? '').trim();
  const visibilityCandidate = visibilityRaw === '' ? 'unlisted' : visibilityRaw;
  if (visibilityCandidate !== 'public' && visibilityCandidate !== 'unlisted') {
    return fail(400, 'invalid_visibility');
  }

  const burnAfterRead = asBool(raw['burn_after_read'], false);
  // A burn paste must never surface in the public feed.
  const visibility: Visibility = burnAfterRead ? 'unlisted' : visibilityCandidate;

  const passwordRaw = asString(raw['password']);
  if (passwordRaw !== null && passwordRaw.length > MAX_PASSWORD_LENGTH) {
    return fail(400, 'password_too_long');
  }
  const password = passwordRaw === null || passwordRaw.length === 0 ? null : passwordRaw;

  const input: CreateInput = {
    content,
    language,
    title,
    expiration,
    visibility,
    burn_after_read: burnAfterRead,
    password,
    encrypted: asBool(raw['encrypted'], false),
  };

  return { ok: true, input, sizeBytes, lineCount: countLines(content) };
}
