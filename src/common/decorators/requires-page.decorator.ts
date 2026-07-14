/**
 * @RequiresPage — declare that a controller method (or entire class)
 * needs a specific admin page permission before it will run.
 *
 * The permission is enforced by PagePermissionGuard, which:
 *   - short-circuits `SUPER_ADMIN` to always pass (they own the
 *     platform; a config row must never lock them out);
 *   - reads `admin_role_page_permissions` for `ADMIN` users;
 *   - defers to the existing @Roles(...) check for every other role
 *     — this decorator is purely additive.
 *
 * Composes with @Roles; add both when a handler is admin-only AND
 * needs a specific ADMIN permission:
 *
 *   @Roles(Role.SUPER_ADMIN, Role.ADMIN)
 *   @RequiresPage("admin.shopper.write")
 *   @Post(...)
 *
 * Introduced by migration 0039. See common/schemas/page-permissions.ts.
 */

import { SetMetadata } from "@nestjs/common";
import type { PageKey } from "../schemas/page-permissions";

export const REQUIRES_PAGE_KEY = "REQUIRES_PAGE";

// Typed as `PageKey` (not `string`) so a typo in the argument fails
// at compile time instead of silently degrading to "always deny".
export const RequiresPage = (page: PageKey) => SetMetadata(REQUIRES_PAGE_KEY, page);
