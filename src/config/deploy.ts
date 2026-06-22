// One flag, two delivery modes of the same binary (see the plan's double-plane decision):
//   self  — single-tenant, customer self-deployed; RLS not forced (one org per DB); license required.
//   saas  — Nanhara-hosted multi-tenant; Postgres RLS enforced; entitlement comes from the hub.
export type DeployMode = "saas" | "self";

export const deployMode = (): DeployMode => (process.env.DEPLOY_MODE === "saas" ? "saas" : "self");
export const isSaas = (): boolean => deployMode() === "saas";
export const isSelf = (): boolean => deployMode() === "self";
