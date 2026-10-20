// Errors and responses shared by route handlers.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, message, details);
export const forbidden = (message: string) => new ApiError(403, message);
export const notFound = (what: string) => new ApiError(404, `${what} not found`);
export const conflict = (message: string, details?: unknown) => new ApiError(409, message, details);

export const errorResponse = (status: number, error: string, details?: unknown): Response =>
  Response.json(details === undefined ? { error } : { error, details }, { status });
