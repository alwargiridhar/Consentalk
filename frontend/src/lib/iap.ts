// Cross-platform IAP wrapper. On Android/iOS native builds, uses
// `react-native-iap` to talk to Google Play / App Store. On web preview,
// falls back to the MOCKED backend subscribe endpoint.
//
// Subscription product IDs (must match Play Console / App Store Connect):
//   - presence_monthly
//   - presence_yearly
//
// After a successful purchase the client POSTs the receipt to
// `/api/billing/google-play/verify-purchase` so the server can grant
// entitlement and persist the purchase_token for later re-verification.

import { Platform } from "react-native";
import { api } from "./api";

const NATIVE = Platform.OS === "android" || Platform.OS === "ios";

export const PRODUCT_IDS = ["presence_monthly", "presence_yearly"] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];

interface IapSdk {
  initConnection?: () => Promise<any>;
  endConnection?: () => Promise<any>;
  getSubscriptions?: (args: { skus: string[] }) => Promise<any[]>;
  requestSubscription?: (args: { sku: string }) => Promise<any>;
  getAvailablePurchases?: () => Promise<any[]>;
  finishTransaction?: (args: any) => Promise<any>;
}

let _sdk: IapSdk | null = null;

async function getSdk(): Promise<IapSdk | null> {
  if (!NATIVE) return null;
  if (_sdk) return _sdk;
  try {
    // Lazy require so the web bundle never tries to load native modules.
    // We use the string-based require below indirected through a variable
    // to defeat Metro's static dependency analysis on web (`react-native-iap`
    // pulls in `react-native-nitro-modules` which is native-only).
    const moduleName = "react-native-iap";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req: any = (eval("require") as any)(moduleName);
    _sdk = (req?.default || req) as IapSdk;
    if (_sdk?.initConnection) {
      await _sdk.initConnection();
    }
    return _sdk;
  } catch {
    return null;
  }
}

export async function listSubscriptions(): Promise<any[]> {
  const sdk = await getSdk();
  if (!sdk?.getSubscriptions) return [];
  try {
    return await sdk.getSubscriptions({ skus: [...PRODUCT_IDS] });
  } catch {
    return [];
  }
}

export async function purchaseSubscription(productId: ProductId): Promise<{
  ok: boolean;
  premium_until?: string;
  reason?: string;
}> {
  // Helper used by both the web fallback and the native-SDK-missing path.
  const callBackendSubscribe = async () => {
    try {
      const planId =
        productId === "presence_monthly" ? "monthly_inr" : "yearly_inr";
      const r = await api<{ premium_until: string }>("/billing/subscribe", {
        body: { plan_id: planId },
      });
      return { ok: true, premium_until: r.premium_until } as const;
    } catch (e: any) {
      return { ok: false, reason: e?.message || "Subscribe failed" } as const;
    }
  };

  if (!NATIVE) return callBackendSubscribe();

  const sdk = await getSdk();
  // If `react-native-iap` is not bundled (e.g. removed to keep the AAB build
  // green while the Play Store package name is being unlocked), fall back to
  // the backend subscribe endpoint so the in-app flow keeps working.
  if (!sdk?.requestSubscription) return callBackendSubscribe();

  try {
    const purchase: any = await sdk.requestSubscription({ sku: productId });
    if (!purchase) {
      return { ok: false, reason: "Purchase cancelled" };
    }
    const purchaseToken =
      purchase.purchaseToken ||
      purchase.transactionReceipt ||
      purchase.purchaseTokenAndroid ||
      "";
    const orderId =
      purchase.orderId || purchase.transactionId || purchase.transactionIdIOS;
    // Send to server for entitlement
    const v = await api<{
      ok: boolean;
      premium_until?: string;
    }>("/billing/google-play/verify-purchase", {
      body: {
        product_id: productId,
        purchase_token: purchaseToken,
        order_id: orderId,
        purchase_state: 1,
      },
    });
    // Acknowledge / finish the transaction on the device
    try {
      if (sdk.finishTransaction) {
        await sdk.finishTransaction({ purchase, isConsumable: false });
      }
    } catch {}
    return { ok: !!v.ok, premium_until: v.premium_until };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "Purchase failed" };
  }
}

export async function restorePurchases(): Promise<{
  ok: boolean;
  is_premium?: boolean;
  premium_until?: string | null;
}> {
  const sdk = await getSdk();
  if (sdk?.getAvailablePurchases) {
    try {
      const items = await sdk.getAvailablePurchases();
      for (const p of items) {
        const productId: ProductId =
          (p.productId as any) || (p.sku as any);
        if (productId !== "presence_monthly" && productId !== "presence_yearly") {
          continue;
        }
        const purchaseToken =
          p.purchaseToken ||
          p.transactionReceipt ||
          p.purchaseTokenAndroid ||
          "";
        await api("/billing/google-play/verify-purchase", {
          body: {
            product_id: productId,
            purchase_token: purchaseToken,
            order_id: p.orderId || p.transactionId,
            purchase_state: 1,
          },
        });
      }
    } catch {}
  }
  // sync state from server
  try {
    const r = await api<{ is_premium: boolean; premium_until?: string | null }>(
      "/billing/restore",
      { method: "POST" }
    );
    return { ok: true, is_premium: r.is_premium, premium_until: r.premium_until };
  } catch {
    return { ok: false };
  }
}

export async function startTrial(): Promise<{
  ok: boolean;
  premium_until?: string;
  reason?: string;
}> {
  try {
    const r = await api<{ premium_until: string }>("/billing/start-trial", {
      method: "POST",
    });
    return { ok: true, premium_until: r.premium_until };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "Couldn't start trial" };
  }
}
