/**
 * Global exception filter that produces RFC 7807 Problem Details responses.
 * Logs the original error with the request's correlation id but never leaks
 * internals (stack traces, ORM errors) to the response in production.
 *
 * Implementation Plan §11.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { Sentry } from "../sentry";

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  errors?: Record<string, string[]>;
  correlationId?: string;
  // Stable error code, e.g., "insufficient_funds", "kyc_pending".
  code?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { correlationId?: string }>();

    const correlationId = req.correlationId ?? (req.headers["x-correlation-id"] as string | undefined);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = "Internal Server Error";
    let detail = "An unexpected error occurred.";
    let errors: Record<string, string[]> | undefined;
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      title = exception.message;
      if (typeof body === "string") {
        detail = body;
      } else if (body && typeof body === "object") {
        const obj = body as {
          message?: string | string[];
          error?: string;
          code?: string;
          errors?: Record<string, string[]>;
        };
        if (Array.isArray(obj.message)) {
          detail = obj.message.join("; ");
        } else if (typeof obj.message === "string") {
          detail = obj.message;
        }
        if (obj.error) title = obj.error;
        if (obj.code) code = obj.code;
        if (obj.errors) errors = obj.errors;
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        { correlationId, err: { message: exception.message, stack: exception.stack } },
        "Unhandled exception",
      );
    }

    // Ship server-side errors (5xx) to Sentry. 4xx is client error and
    // intentionally NOT reported — those are normal traffic. The PII scrub
    // in src/common/sentry.ts strips secrets before the event leaves.
    if (status >= 500) {
      Sentry.withScope((scope) => {
        scope.setTag("path", req.originalUrl ?? req.url ?? "/");
        scope.setTag("method", req.method ?? "UNKNOWN");
        if (correlationId) scope.setTag("correlationId", correlationId);
        if (code) scope.setTag("code", code);
        // Attach the user (id only — beforeSend strips email to a domain hint).
        const authed = (req as Request & { user?: { sub?: string; vendorId?: string } }).user;
        if (authed?.sub) scope.setUser({ id: authed.sub });
        Sentry.captureException(exception);
      });
    }

    const body: ProblemDetails = {
      type: "about:blank",
      title,
      status,
      detail,
      instance: req.originalUrl ?? req.url ?? "/",
      ...(errors ? { errors } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(code ? { code } : {}),
    };

    // Defence in depth: if some upstream middleware (Sentry, helmet, a stream
    // pipe) has already started the response, do NOT try to write the error
    // body. Calling res.setHeader after headersSent is true throws
    // ERR_HTTP_HEADERS_SENT, which Node treats as uncaught and kills the
    // process. Better to log and bail than crash the container.
    if (res.headersSent) {
      this.logger.warn(
        { correlationId, status, code },
        "Exception thrown after response started; skipping body write",
      );
      return;
    }

    res.status(status).type("application/problem+json").send(body);
  }
}
