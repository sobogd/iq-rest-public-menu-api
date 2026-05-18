import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

interface ErrorBody {
  statusCode: number;
  message: string;
  code: string;
  requestId: string;
  path?: string;
}

// Normalises every thrown error into a stable JSON shape so the frontend can
// always show a translated toast and ship a tracking event with a real
// backend message — never a bare 500 / empty body.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Exception");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = "Internal server error";
    let code = "internal_error";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      if (typeof r === "string") {
        message = r;
      } else if (r && typeof r === "object") {
        const obj = r as Record<string, unknown>;
        const m = obj.message;
        if (Array.isArray(m)) message = m.map(String).join("; ");
        else if (typeof m === "string") message = m;
        else if (typeof obj.error === "string") message = obj.error;
        if (typeof obj.code === "string") code = obj.code;
      }
    } else if (exception instanceof Error) {
      message = exception.message || message;
      code = (exception as { code?: string }).code || code;
    }

    const requestId =
      (req.headers["x-request-id"] as string) ||
      Math.random().toString(36).slice(2, 10);

    const body: ErrorBody = {
      statusCode: status,
      message,
      code,
      requestId,
      path: req.originalUrl,
    };

    // Log everything ≥500 with stack; client errors stay quiet to avoid log noise.
    if (status >= 500) {
      this.logger.error(
        `[${requestId}] ${req.method} ${req.originalUrl} ${status} ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`[${requestId}] ${req.method} ${req.originalUrl} ${status} ${message}`);
    }

    res.status(status).json(body);
  }
}
