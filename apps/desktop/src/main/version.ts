import pkg from "../../package.json" with { type: "json" };
export const APP_VERSION = pkg.version;
export const APP_LABEL = APP_VERSION.replace(/-preview\.(\d+)/, " Preview $1");
