export class DashboardSessionExpired extends Error {
  constructor() {
    super("Your dashboard session has expired. Please sign in again.");
    this.name = "DashboardSessionExpired";
  }
}

let redirectStarted = false;
export function redirectToDashboardLogin() {
  if (typeof window !== "undefined" && !redirectStarted) {
    redirectStarted = true;
    window.location.replace("/login?reason=session-expired");
  }
}

// Keep one authenticated request policy for all dashboard panels. A 401 must
// never be retried as a measurement/settings write or leave a stale panel open.
export function createDashboardFetch(request: typeof fetch, onUnauthorized: () => void) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await request(input, { ...init, credentials: "same-origin" });
    if (response.status === 401) {
      onUnauthorized();
      throw new DashboardSessionExpired();
    }
    return response;
  };
}

export const dashboardFetch = createDashboardFetch(
  (input, init) => fetch(input, init),
  redirectToDashboardLogin,
);
