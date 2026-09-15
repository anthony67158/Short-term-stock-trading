import createClient from "openapi-fetch";
import type { paths } from "../../../../packages/api-client/schema";

// https://openapi-ts.dev/openapi-fetch/ — generated Python→OpenAPI→TS contract.
export const api = createClient<paths>({
  baseUrl: "",
  credentials: "same-origin",
  fetch: (request) => {
    const timeout = AbortSignal.timeout(15_000);
    const signal = AbortSignal.any([request.signal, timeout]);
    return fetch(new Request(request, { signal }));
  },
});

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "error" in error) {
    const detail = error.error;
    if (typeof detail === "object" && detail && "message" in detail) {
      return String(detail.message);
    }
  }
  return error instanceof Error ? error.message : "操作未完成，请稍后重试";
}
