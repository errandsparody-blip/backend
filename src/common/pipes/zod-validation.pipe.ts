/**
 * ZodValidationPipe — validates request bodies/queries against a Zod schema.
 * Returns RFC 7807-compatible error responses via the global exception filter.
 *
 * Usage:
 *   @Post('login')
 *   login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput) { ... }
 */

import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const errors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.length ? issue.path.join(".") : "_";
        if (!errors[path]) errors[path] = [];
        errors[path].push(issue.message);
      }
      throw new BadRequestException({
        message: "Validation failed.",
        error: "Bad Request",
        code: "validation_failed",
        errors,
      });
    }
    return result.data;
  }
}
