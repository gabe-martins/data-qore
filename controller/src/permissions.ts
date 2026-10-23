export const profiles = ["viewer", "quality_manager", "developer", "platform_admin"] as const;
export type Profile = typeof profiles[number];
export const profileLabels: Record<Profile, string> = {
  viewer: "Results Viewer", quality_manager: "Quality Manager",
  developer: "Data Developer", platform_admin: "Platform Administrator",
};
const read = ["dashboard.read", "results.read"];
const quality = [...read, "datasets.read", "comparisons.read", "comparisons.manage", "runs.execute", "schedules.read", "schedules.manage"];
const development = [...quality, "connections.read", "connections.manage", "catalog.read", "datasets.manage"];
export const profilePermissions: Record<Profile, readonly string[]> = {
  viewer: read, quality_manager: quality, developer: development,
  platform_admin: [...development, "access.manage", "audit.read"],
};
export function permissionsFor(profile: string): readonly string[] {
  return Object.hasOwn(profilePermissions, profile) ? profilePermissions[profile as Profile] : [];
}
// Explicit method/template pairs: adding an engine endpoint never grants access implicitly.
const policies: Record<string, string> = {};
function routes(permission: string, method: string, paths: string[]) {
  for (const path of paths) policies[`${method} /api/v1${path}`] = permission;
}
routes("dashboard.read", "get", ["/overview", "/overview/row-match-trend"]);
routes("results.read", "get", ["/runs", "/runs/{identifier}", "/runs/{identifier}/result"]);
routes("connections.read", "get", ["/connectors", "/connections", "/connections/{identifier}", "/connections/{identifier}/dependencies"]);
routes("connections.manage", "post", ["/connections", "/connections/test", "/connections/{identifier}/test"]);
routes("connections.manage", "patch", ["/connections/{identifier}"]);
routes("connections.manage", "delete", ["/connections/{identifier}"]);
routes("catalog.read", "get", ["/connections/{identifier}/catalogs", "/connections/{identifier}/schemas", "/connections/{identifier}/tables"]);
routes("datasets.read", "get", ["/datasets", "/datasets/{identifier}", "/datasets/{identifier}/dependencies"]);
routes("datasets.manage", "post", ["/datasets", "/datasets/{identifier}/refresh"]);
routes("datasets.manage", "delete", ["/datasets/{identifier}"]);
routes("comparisons.read", "get", ["/comparison-summaries", "/comparisons", "/comparisons/{identifier}", "/comparisons/{identifier}/dependencies"]);
routes("comparisons.manage", "post", ["/comparisons", "/comparisons/preview"]);
routes("comparisons.manage", "patch", ["/comparisons/{identifier}"]);
routes("comparisons.manage", "delete", ["/comparisons/{identifier}"]);
routes("runs.execute", "post", ["/comparisons/{identifier}/runs"]);
routes("schedules.read", "get", ["/schedules", "/schedules/{id}", "/schedules/{id}/dispatches"]);
routes("schedules.manage", "post", ["/schedules", "/schedules/preview"]);
routes("schedules.manage", "patch", ["/schedules/{id}"]);
routes("access.manage", "get", ["/users", "/groups"]);
routes("access.manage", "post", ["/users", "/groups", "/users/{id}/reset-password", "/users/{id}/revoke-sessions"]);
routes("access.manage", "patch", ["/users/{id}", "/groups/{id}"]);
routes("access.manage", "delete", ["/groups/{id}"]);
routes("audit.read", "get", ["/audit-log"]);
export function routePermission(method: string, path: string): string | undefined {
  const template = path.replace(/:([^/]+)/g, "{$1}");
  return policies[`${method.toLowerCase()} ${template}`];
}
export const selfServicePaths = new Set(["get /api/v1/auth/me", "post /api/v1/auth/logout", "post /api/v1/auth/change-password"]);
export const publicPaths = new Set(["post /api/v1/auth/login", "post /api/v1/auth/refresh"]);
