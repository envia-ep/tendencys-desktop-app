export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON() {
    return {
      success: false as const,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function ok<T extends object>(data: T) {
  return { success: true as const, data };
}

export function unauthorized(message = "Unauthorized") {
  return new AppError("UNAUTHORIZED", message, 401);
}

export function forbidden(message = "Forbidden") {
  return new AppError("FORBIDDEN", message, 403);
}

export function notFound(resource: string) {
  return new AppError("NOT_FOUND", `${resource} not found`, 404);
}

export function conflict(message: string) {
  return new AppError("CONFLICT", message, 409);
}

export function graphChanged() {
  return new AppError("GRAPH_CHANGED", "Organization graph changed", 409);
}

export function validationError(message: string, details?: unknown) {
  return new AppError("VALIDATION_ERROR", message, 400, details);
}
