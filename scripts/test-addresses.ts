import { supabaseAdmin } from "../src/lib/supabase.js";

/**
 * The saved-address book.
 *
 * Uses throwaway customer phones outside any real range; every customer and
 * address created here is removed in the finally block. No existing customer,
 * address or order is read or modified.
 *
 * Requires supabase/customer-addresses.sql.
 */

const API = process.env.TEST_API ?? "https://conroy-backend.vercel.app/api";
const ALICE = "+919000000801";
const MALLORY = "+919000000802";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown, detail = "") {
  if (actual === expected) {
    passed++;
    console.log(`  PASS  ${name} → ${String(actual)}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} → expected ${String(expected)}, got ${String(actual)}  ${detail}`);
  }
}

interface Address {
  id: string;
  fullName: string;
  line1: string;
  city: string;
  label: string;
  isDefault: boolean;
}

const body = (extra: Record<string, unknown> = {}) => ({
  fullName: "Test Customer",
  phone: "+919999999999",
  line1: "1 Example Street",
  line2: "Near the landmark",
  city: "Ahmedabad",
  state: "Gujarat",
  pincode: "380009",
  ...extra,
});

async function list(phone: string): Promise<Address[]> {
  const res = await fetch(`${API}/addresses?phone=${encodeURIComponent(phone)}`);
  return ((await res.json()) as { data?: Address[] }).data ?? [];
}

async function create(customerPhone: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${API}/addresses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerPhone, ...body(extra) }),
  });
  const json = (await res.json()) as { data?: Address; error?: string };
  return { status: res.status, address: json.data, error: json.error };
}

try {
  const probe = await supabaseAdmin.from("customer_addresses").select("id").limit(1);
  if (probe.error) {
    console.log("MIGRATION NOT APPLIED — run supabase/customer-addresses.sql first.");
    console.log(`  (${probe.error.message})`);
    process.exitCode = 1;
    throw new Error("migration missing");
  }
  console.log(`API: ${API}\n`);

  console.log("1. A customer with no addresses has an empty book");
  check("starts empty", (await list(ALICE)).length, 0);

  console.log("\n2. The first saved address becomes the default");
  const first = await create(ALICE, { label: "Home" });
  check("created", first.status, 201, String(first.error));
  check("is default", first.address?.isDefault, true);
  check("label kept", first.address?.label, "Home");

  console.log("\n3. A second address does not steal the default");
  const second = await create(ALICE, { label: "Work", line1: "2 Office Road" });
  check("created", second.status, 201, String(second.error));
  check("not default", second.address?.isDefault, false);
  const book = await list(ALICE);
  check("book has both", book.length, 2);
  check("default listed first", book[0]?.id, first.address?.id);

  console.log("\n4. The customer can move the default");
  const promoted = await fetch(`${API}/addresses/${second.address!.id}/default`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerPhone: ALICE }),
  });
  check("accepted", promoted.status, 200);
  const afterPromote = await list(ALICE);
  check("second is default", afterPromote.find((a) => a.id === second.address!.id)?.isDefault, true);
  check("first no longer default", afterPromote.find((a) => a.id === first.address!.id)?.isDefault, false);
  check("still exactly one default", afterPromote.filter((a) => a.isDefault).length, 1);

  console.log("\n5. Editing updates in place rather than duplicating");
  const edited = await fetch(`${API}/addresses/${first.address!.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerPhone: ALICE, line1: "1 Renamed Street", label: "Other" }),
  });
  check("accepted", edited.status, 200);
  const afterEdit = await list(ALICE);
  check("count unchanged", afterEdit.length, 2);
  check("line updated", afterEdit.find((a) => a.id === first.address!.id)?.line1, "1 Renamed Street");
  check("label updated", afterEdit.find((a) => a.id === first.address!.id)?.label, "Other");

  console.log("\n6. Deleting the default promotes another");
  const removed = await fetch(
    `${API}/addresses/${second.address!.id}?phone=${encodeURIComponent(ALICE)}`,
    { method: "DELETE" },
  );
  check("accepted", removed.status, 200);
  const afterDelete = await list(ALICE);
  check("one left", afterDelete.length, 1);
  check("survivor is default", afterDelete[0]?.isDefault, true, JSON.stringify(afterDelete[0]));

  console.log("\n7. One customer cannot touch another's address");
  const victimId = afterDelete[0]!.id;
  const peek = await fetch(`${API}/addresses/${victimId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerPhone: MALLORY, line1: "Hijacked" }),
  });
  check("edit refused", peek.status, 404, await peek.clone().text());

  const steal = await fetch(`${API}/addresses/${victimId}?phone=${encodeURIComponent(MALLORY)}`, {
    method: "DELETE",
  });
  check("delete refused", steal.status, 404);

  const hijackDefault = await fetch(`${API}/addresses/${victimId}/default`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerPhone: MALLORY }),
  });
  check("default change refused", hijackDefault.status, 404);

  const stillThere = await list(ALICE);
  check("address untouched", stillThere[0]?.line1, "1 Renamed Street");
  check("other customer sees nothing", (await list(MALLORY)).length, 0);

  console.log("\n8. Invalid input is rejected with a message");
  const bad = await create(ALICE, { pincode: "abc" });
  check("bad pincode refused", bad.status, 400, String(bad.error));
  const blank = await create(ALICE, { line1: "" });
  check("blank address refused", blank.status, 400, String(blank.error));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  for (const phone of [ALICE, MALLORY]) {
    await supabaseAdmin.from("customer_addresses").delete().eq("customer_phone", phone);
    await supabaseAdmin.from("users").delete().eq("phone", phone);
  }
  const { count } = await supabaseAdmin
    .from("customer_addresses")
    .select("*", { count: "exact", head: true })
    .in("customer_phone", [ALICE, MALLORY]);
  console.log(`\ncleanup: test customers removed, ${count ?? 0} addresses left`);
}
