export type AtlasAction =
  | "read"
  | "bootstrap"
  | "create"
  | "update"
  | "delete"
  | "invite";

export function hasAtlasPermission(
  roleValue: string,
  action: AtlasAction,
): boolean {
  const roles = new Set(
    roleValue.split(",").map((role) => role.trim()).filter(Boolean),
  );
  if (roles.has("owner")) return true;
  if (!roles.has("member")) return false;
  return action === "read" || action === "create" || action === "update";
}
