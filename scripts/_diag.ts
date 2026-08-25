import { supabaseAdmin } from "../src/lib/supabase.js";
const { data: o } = await supabaseAdmin.from("orders")
  .select("id, full_name, status, fulfillment_status, created_at").order("created_at");
console.log("=== orders ===");
for (const r of (o ?? []) as Record<string,string>[])
  console.log(`  ${r.id.slice(0,8)} ${String(r.full_name).slice(0,18).padEnd(19)} ${r.status}/${r.fulfillment_status} ${r.created_at}`);

const { data: s } = await supabaseAdmin.from("shipments")
  .select("id, order_id, waybill, ref_no, status, create_response, created_at").order("created_at");
console.log("=== shipments ===");
for (const r of (s ?? []) as Record<string,unknown>[])
  console.log(`  order=${String(r.order_id).slice(0,8)} waybill=${r.waybill ?? "NULL"} status=${r.status} created=${r.created_at}\n     create_response=${JSON.stringify(r.create_response)?.slice(0,300)}`);

const { data: j } = await supabaseAdmin.from("shipment_jobs")
  .select("order_id, kind, state, attempts, next_run_at, last_error, created_at").order("created_at");
console.log(`=== shipment_jobs: ${j?.length ?? 0} ===`);
for (const r of (j ?? []) as Record<string,unknown>[])
  console.log(`  order=${String(r.order_id).slice(0,8)} ${r.kind}/${r.state} attempts=${r.attempts} next=${r.next_run_at}\n     last_error=${r.last_error ?? "-"}`);
