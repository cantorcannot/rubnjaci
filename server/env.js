export function getEnv() {
  const required = ["KOBO_BASE_URL", "KOBO_ASSET_UID", "KOBO_API_TOKEN", "KOBO_PUBLIC_FORM_URL"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);

  return {
    KOBO_BASE_URL: process.env.KOBO_BASE_URL,
    KOBO_ASSET_UID: process.env.KOBO_ASSET_UID,
    KOBO_API_TOKEN: process.env.KOBO_API_TOKEN,
    KOBO_PUBLIC_FORM_URL: process.env.KOBO_PUBLIC_FORM_URL,
    DGU_ORTHO_WMS_URL: process.env.DGU_ORTHO_WMS_URL || "https://geoportal.dgu.hr/services/inspire/orthophoto_2023_2024/ows",
    DGU_ORTHO_LAYER: process.env.DGU_ORTHO_LAYER || "OI.OrthoimageCoverage"
  };
}
