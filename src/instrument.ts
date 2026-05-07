/**
 * Sentry pre-bootstrap. Imported as the very first statement of main.ts.
 *
 * Sentry's @sentry/node SDK uses OpenTelemetry under the hood and patches
 * core Node modules (http, fs, dns, …) at require-time. If Nest is imported
 * BEFORE this file, those patches miss the modules already loaded —
 * autoinstrumentation degrades silently.
 *
 * Keep this file minimal so the import-order constraint is obvious to
 * future readers.
 */

import { initSentry } from "./common/sentry";

initSentry();
