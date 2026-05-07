import { SetMetadata } from "@nestjs/common";
import type { Role } from "@prisma/client";

export const ROLES_KEY = "ROLES";

/**
 * Restrict a controller method (or controller class) to one or more roles.
 * Composes with JwtAuthGuard via RolesGuard. Implementation Plan §4.2.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
