export class AppError extends Error {
  constructor(message: string, public readonly statusCode = 500, public readonly details?: unknown) {
    super(message);
  }
}

export function assertDatabaseResult(error: { message: string; details?: string } | null) {
  if (error) throw new AppError(error.message, 500, error.details);
}
