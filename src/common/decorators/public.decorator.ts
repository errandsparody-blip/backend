import { SetMetadata } from "@nestjs/common";

/**
 * Mark a controller method as exempt from JwtAuthGuard. Use sparingly — only
 * for genuinely public endpoints (login, signup, password reset, webhooks).
 */
export const IS_PUBLIC_KEY = "IS_PUBLIC";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
