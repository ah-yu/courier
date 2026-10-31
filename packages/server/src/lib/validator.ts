/** One rejected field, in the shape every validation failure answers with. */
export interface ValidationIssue {
  field: string;
  message: string;
}

/**
 * Zod issues → the `details` array of a validation failure.
 *
 * Shared because two routes validate a body the same way but cannot use the same
 * middleware: the JSON routes go through `createValidator`, while the push route
 * parses a **binary frame** and validates the header it carried
 * (`routes/sync.ts`). One mapper keeps the two answers identical.
 */
export function validationDetails(
  issues: readonly { path: PropertyKey[]; message: string }[],
): ValidationIssue[] {
  return issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));
}

/**
 * Creates a Zod validator middleware that returns a unified error format on validation failure.
 */
