import diagnostics_channel from "unenv/node/diagnostics_channel";
export * from "unenv/node/diagnostics_channel";

export const createDiagnosticsChannelShim = (): typeof diagnostics_channel => {
  return diagnostics_channel;
};

export default createDiagnosticsChannelShim();
