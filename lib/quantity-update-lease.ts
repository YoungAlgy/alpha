import type { SupabaseClient } from "@supabase/supabase-js";

type RpcClient = Pick<SupabaseClient, "rpc">;

export async function claimQuantityUpdateLease(
  sb: RpcClient,
  userId: string,
  leaseToken: string,
  leaseSeconds = 180
): Promise<boolean> {
  if (
    !userId ||
    !leaseToken ||
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < 30 ||
    leaseSeconds > 300
  ) {
    throw new Error("quantity update lease input is invalid");
  }
  const { data, error } = await sb.rpc("claim_alpha_quantity_update", {
    p_user_id: userId,
    p_lease_token: leaseToken,
    p_lease_seconds: leaseSeconds,
  });
  if (error || typeof data !== "boolean") {
    throw new Error("quantity update lease could not be claimed");
  }
  return data;
}

export async function releaseQuantityUpdateLease(
  sb: RpcClient,
  userId: string,
  leaseToken: string
): Promise<boolean> {
  if (!userId || !leaseToken) {
    throw new Error("quantity update lease input is invalid");
  }
  const { data, error } = await sb.rpc("release_alpha_quantity_update", {
    p_user_id: userId,
    p_lease_token: leaseToken,
  });
  if (error || typeof data !== "boolean") {
    throw new Error("quantity update lease could not be released");
  }
  return data;
}
