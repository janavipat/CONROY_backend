import { editSucceeded } from "../src/lib/shipping/providers/delhivery/manifest.js";

/**
 * Delhivery's /api/p/edit reports success as a boolean on some accounts and as
 * the string "Success" on others. Only the string was accepted, so a genuinely
 * cancelled shipment was read as a failure and the order was left active —
 * these cases pin that down. No network or database access.
 */

let passed = 0;
let failed = 0;

function check(name: string, actual: boolean, expected: boolean) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS  ${name} → ${actual}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} → expected ${expected}, got ${actual}`);
  }
}

console.log("Delhivery cancel response shapes");
check('{ status: true }', editSucceeded({ status: true }), true);
check('{ status: "Success" }', editSucceeded({ status: "Success" }), true);
check('{ status: "success" }', editSucceeded({ status: "success" }), true);
check('{ status: " Success " }', editSucceeded({ status: " Success " }), true);

check('{ status: false }', editSucceeded({ status: false }), false);
check('{ status: "Failure" }', editSucceeded({ status: "Failure" }), false);
check('{ status: "Failure", error }', editSucceeded({ status: "Failure", error: "no such waybill" }), false);
check("{} (no status)", editSucceeded({}), false);
check("null body", editSucceeded(null), false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
