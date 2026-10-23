import { createContext, useContext, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import type { User } from "../api";
export const AccessContext = createContext<User | null>(null);
export const useAccess = () => useContext(AccessContext);
export function useCan(permission: string) { return useAccess()?.permissions.includes(permission) ?? false; }
export function Allowed({ permission, children }: { permission: string; children: ReactNode }) {
  return useCan(permission) ? children : null;
}
export function Protected({ permission, children }: { permission: string; children: ReactNode }) {
  const user = useAccess();
  if (user?.must_change_password) return <Navigate to="/account" replace />;
  return user?.permissions.includes(permission) ? children : <p role="alert">You do not have permission to access this page.</p>;
}
export const profileLabels: Record<string, string> = { viewer: "Results Viewer", quality_manager: "Quality Manager", developer: "Data Developer", platform_admin: "Platform Administrator" };
export const profileDescriptions: Record<string, string> = {
  viewer: "Read dashboard, run history and results.",
  quality_manager: "Read results and datasets; manage comparisons, executions and schedules.",
  developer: "Quality Manager permissions plus connection and catalog management.",
  platform_admin: "Full data operations, user and group administration, session revocation and security audit.",
};
