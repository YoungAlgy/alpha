export type AlphaAccessMode = "invite" | "paid";

// Alpha is permanently invite-only. Keep the legacy "paid" type so retained
// billing settlement code can still describe historical state, but no runtime
// environment value may reopen checkout or paid plan changes.
export function alphaAccessMode(_server = false): AlphaAccessMode {
  void _server;
  return "invite";
}

export function isInviteOnly(_server = false): boolean {
  void _server;
  return true;
}
