/**
 * Exposes BB's ACP provider bridge to the host daemon and registers the
 * Antigravity dialect at module initialization so health and quota requests
 * route through `agy` within the same isolated host bundle.
 */

import {
  experimental_acpProviderBridge,
  experimental_registerAcpDialect,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { antigravityDialect } from "./src/dialect.ts";

experimental_registerAcpDialect(antigravityDialect);

export const experimental_providerBridge = experimental_acpProviderBridge;
