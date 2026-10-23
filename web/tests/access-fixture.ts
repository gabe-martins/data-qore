export const adminUser = {
  id: "designer", display_name: "DataQore Administrator", email: "admin@example.test",
  group: { id: "admin-group", name: "Platform Administrators" }, profile: "platform_admin", must_change_password: false,
  permissions: ["dashboard.read", "results.read", "datasets.read", "comparisons.read", "comparisons.manage", "runs.execute", "schedules.read", "schedules.manage", "connections.read", "connections.manage", "catalog.read", "datasets.manage", "access.manage", "audit.read"],
};
