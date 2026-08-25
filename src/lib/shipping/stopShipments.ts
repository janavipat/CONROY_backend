import { supabaseAdmin } from "../supabase.js";
import { delhiveryProvider } from "./providers/delhivery/index.js";

export interface StopShipmentsResult {
  /**
   * Shipment rows whose courier booking is confirmed stopped. The caller
   * writes its own state change first and only then touches these rows, so a
   * failure can never leave the courier cancelled and the order still live.
   */
  stopped: string[];
  /**
   * Set when the courier refused. The caller must leave every record exactly
   * as it was and surface this to the operator.
   */
  blocked?: { status: number; message: string };
}

/**
 * Stops every live courier booking for an order, using the one Delhivery
 * integration the project already has. Shared by the customer cancellation and
 * the admin delete so the two can never drift apart.
 *
 * Nothing here writes to the database — the decision is returned and the caller
 * decides what to persist.
 */
export async function stopShipmentsForOrder(orderId: string): Promise<StopShipmentsResult> {
  // Every shipment row, not one: a re-attempted booking leaves a second
  // waybill behind, and maybeSingle() would return null for that order and
  // skip the courier cancellation altogether.
  const { data: shipmentRows } = await supabaseAdmin
    .from("shipments")
    .select("id, waybill, create_response")
    .eq("order_id", orderId)
    .neq("status", "Cancelled");

  type ShipmentRow = { id: string; waybill: string | null; create_response: unknown };
  const stopped: string[] = [];

  for (const shipment of (shipmentRows ?? []) as ShipmentRow[]) {
    const waybill = shipment.waybill ?? undefined;
    if (!waybill) continue;

    // A row Delhivery never acknowledged was never really booked, so there is
    // no pickup to stop — used below to avoid blocking on a stale row.
    const booked = (shipment.create_response as { success?: boolean } | null)?.success === true;
    const cancelled = await delhiveryProvider.cancelShipment({ waybill });

    if (!cancelled.ok) {
      const detail = cancelled.error?.message ?? "";
      // The raw body is the only way to tell these cases apart after the fact,
      // so it is logged in full rather than summarised.
      console.warn(
        `Delhivery cancel failed for order ${orderId} (waybill ${waybill}): ${detail}`,
        JSON.stringify(cancelled.raw),
      );

      /*
       * cancelShipment reports every non-Success as "permanent", which means
       * "do not retry" — not "the parcel has been collected". Treating the two
       * as the same told customers the courier had their order whenever
       * Delhivery replied anything other than Success, including for a waybill
       * it had never heard of.
       */
      const says = detail.toLowerCase();
      const unknownWaybill =
        says.includes("not found") ||
        says.includes("does not exist") ||
        says.includes("no waybill") ||
        says.includes("invalid waybill");
      const alreadyCancelled = says.includes("already") && says.includes("cancel");
      const inTransit =
        says.includes("picked") ||
        says.includes("transit") ||
        says.includes("dispatched") ||
        says.includes("out for delivery");

      if (inTransit) {
        // The one case where the parcel really is gone.
        return {
          stopped,
          blocked: {
            status: 409,
            message:
              "This order is already with the courier and can no longer be cancelled. Please refuse the delivery or start a return once it arrives.",
          },
        };
      }

      if (booked && !unknownWaybill && !alreadyCancelled) {
        // Anything else is unresolved. Nothing is changed while a live shipment
        // could still go out.
        return {
          stopped,
          blocked: {
            status: 503,
            message: "We couldn't confirm the cancellation with the courier. Please try again in a moment.",
          },
        };
      }

      // A waybill Delhivery does not recognise, one it has already cancelled,
      // or a row it never acknowledged in the first place all mean nothing is
      // going to be collected — so the caller can safely proceed rather than
      // being blocked forever by a stale shipment row.
    }

    stopped.push(shipment.id);
  }

  return { stopped };
}
