/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

/**
 * `@astrojs/cloudflare` v14 populates `Astro.locals` with its `Runtime` shape —
 * `{ cfContext: ExecutionContext }`. (`locals.runtime` still exists at runtime as
 * a deprecated getter, but it is not part of the type; use `locals.cfContext`.)
 *
 * Declared with an inline `import(...)` type so this file stays a global script
 * and the `App` augmentation applies project-wide.
 */
type CloudflareRuntime = import('@astrojs/cloudflare').Runtime;

declare namespace App {
  interface Locals extends CloudflareRuntime {}
}
