/**
 * Seeds sample product reviews into Supabase through the existing reviews table.
 * Run after the catalog is seeded:  npm run seed:reviews
 *
 * Idempotent: each review gets a deterministic UUID derived from its product
 * handle and index, so re-running upserts the same rows rather than piling up
 * duplicates. Reviews left by real customers are never touched. Afterwards
 * every product's `rating` / `review_count` is recomputed from the reviews
 * table — the same aggregate refreshProductAggregate() writes on submit.
 */
import { createHash } from "node:crypto";
import { supabaseAdmin } from "../src/lib/supabase.js";

interface SeedReview {
  author: string;
  rating: number;
  title: string;
  body: string;
  /** ISO date (YYYY-MM-DD) — fixed so re-seeding stays deterministic. */
  date: string;
}

/** Deterministic UUIDv5-style id, so re-runs update in place instead of duplicating. */
function reviewId(handle: string, index: number): string {
  const h = createHash("sha1").update(`conroy:review:${handle}:${index}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const REVIEWS: Record<string, SeedReview[]> = {
  // ── Denim ────────────────────────────────────────────────────────────────
  pants: [
    {
      author: "Arjun Mehta",
      rating: 5,
      title: "Perfect black denim",
      body: "Ordered size 32 and the fit is spot on — straight through the leg without being tight at the thigh. The soft-wash finish feels premium and the subtle fading looks really good in person. Stitching is neat all around, especially at the pockets.",
      date: "2026-03-14",
    },
    {
      author: "Rohit Nair",
      rating: 5,
      title: "Comfortable for all-day wear",
      body: "Wore these for a full day of travel and they never felt stiff. The denim has a soft hand-feel from the first wear, no break-in needed. The black is deep and hasn't faded after three washes.",
      date: "2026-05-02",
    },
    {
      author: "Sandeep Kulkarni",
      rating: 4,
      title: "Great quality, size up if you're between",
      body: "Fabric quality is genuinely good — thick but not heavy. I'm between 32 and 34 and went with 34, which turned out right. Only thing is the length was slightly long for me, an easy alteration though.",
      date: "2026-06-21",
    },
    {
      author: "Vikram Joshi",
      rating: 5,
      title: "Looks smarter than the price suggests",
      body: "Clean straight leg that falls nicely over shoes. Pairs well with both a tee and a shirt. The five-pocket construction and the button-and-zip fly all feel solid, nothing flimsy about the hardware.",
      date: "2026-07-30",
    },
    {
      author: "Salman Merchant",
      rating: 4,
      title: "Solid everyday black",
      body: "Been wearing these a couple of months now. The soft-wash finish still looks good and the shape has held through repeated washes. Minor point — I would have liked an extra inch in the inseam.",
      date: "2026-08-13",
    },
  ],
  "black-pent": [
    {
      author: "Karthik Iyer",
      rating: 5,
      title: "Classic indigo done right",
      body: "The indigo shade is rich and looks exactly like the pictures. Tailored through the leg so it doesn't read baggy, but there's still enough room to sit comfortably all day.",
      date: "2026-02-08",
    },
    {
      author: "Aditya Rao",
      rating: 5,
      title: "Softens beautifully",
      body: "Bought these two months ago and they have only got more comfortable. The denim has that lived-in feel now without losing its shape. Waist is true to size at 34.",
      date: "2026-04-19",
    },
    {
      author: "Manish Agarwal",
      rating: 4,
      title: "Good fabric, neat finish",
      body: "The denim weave feels premium and the stitching is even throughout — no loose threads anywhere. The mid rise works well for me. Colour bled a little in the first wash but nothing since.",
      date: "2026-06-05",
    },
    {
      author: "Nikhil Bhatt",
      rating: 4,
      title: "Goes with everything",
      body: "This is the jean I reach for most now. The straight leg keeps the look clean, and the blue is versatile enough for both office-casual and weekends.",
      date: "2026-07-11",
    },
  ],
  "dark-blue-straight-fit": [
    {
      author: "Siddharth Menon",
      rating: 5,
      title: "The tan stitching makes it",
      body: "Deep indigo with the contrast tan thread looks really sharp in daylight. The leather patch at the back feels like actual leather rather than a print. Fit is clean and straight from the knee down.",
      date: "2026-01-27",
    },
    {
      author: "Harsh Patel",
      rating: 5,
      title: "Holds its shape",
      body: "Three weeks in and no sagging at the knees, which is usually my complaint with denim at this price. The fabric is substantial and the wash is deep and even.",
      date: "2026-03-30",
    },
    {
      author: "Praveen Reddy",
      rating: 4,
      title: "Comfortable, slightly stiff at first",
      body: "Took a couple of wears to break in, but it is very comfortable now. Size 36 fit true. Stitching quality is excellent — you can tell from the double-needle seams at the inseam.",
      date: "2026-05-24",
    },
    {
      author: "Ashwin Deshpande",
      rating: 5,
      title: "Looks premium",
      body: "Honestly looks like something twice the price. The dark indigo dresses up nicely with a white shirt. Pockets are well placed and the hardware feels sturdy.",
      date: "2026-07-18",
    },
    {
      author: "Ramesh Iyengar",
      rating: 5,
      title: "Excellent stitching",
      body: "What stood out to me is the stitching — even, tight and consistent everywhere I looked, including the belt loops. The deep indigo is a proper dark wash, not a faded stand-in.",
      date: "2026-08-08",
    },
  ],
  "ice-blue-straight-fit": [
    {
      author: "Rahul Verma",
      rating: 5,
      title: "Great summer wash",
      body: "The light wash is perfect for hot weather and looks fresh with a white tee. The soft faded finish looks natural, not artificially distressed at all.",
      date: "2026-04-06",
    },
    {
      author: "Tanmay Ghosh",
      rating: 4,
      title: "Very comfortable straight leg",
      body: "Roomy enough through the thigh and falls straight without flaring at the hem. Sat in these all day at work with no discomfort. The denim is soft from day one.",
      date: "2026-05-15",
    },
    {
      author: "Imran Sheikh",
      rating: 4,
      title: "Nice colour, runs slightly relaxed",
      body: "The sky blue shade is lovely and true to the photos. The fit is a touch more relaxed than I expected at size 30 — forgiving rather than tight. Stitching neat throughout.",
      date: "2026-06-28",
    },
    {
      author: "Gaurav Malhotra",
      rating: 4,
      title: "Light and easy",
      body: "Lighter in weight than my darker jeans, which I prefer for daily wear. The colour hasn't washed out after a few cycles. Good buy.",
      date: "2026-08-02",
    },
  ],
  "indigo-straight-fit": [
    {
      author: "Abhinav Saxena",
      rating: 5,
      title: "Sharp slim cut",
      body: "Tapers nicely through the thigh and knee without being restrictive. The subtle whiskering gives it character. Looks great with a striped shirt, exactly as described.",
      date: "2026-02-21",
    },
    {
      author: "Yash Chauhan",
      rating: 5,
      title: "Dark indigo is deep and even",
      body: "The rinse wash is uniform with no patchiness anywhere. The fabric has a bit of give to it, comfortable even sitting for long hours at a desk.",
      date: "2026-04-27",
    },
    {
      author: "Deepak Sharma",
      rating: 4,
      title: "Slim but wearable",
      body: "If you have heavier thighs, consider sizing up. For me at 32 it was a good slim fit. Stitching and finishing are properly done — the belt loops feel reinforced.",
      date: "2026-06-13",
    },
    {
      author: "Sameer Qureshi",
      rating: 4,
      title: "Dresses up well",
      body: "Wore these to dinner with a blazer and they held up to the occasion. The clean line and dark colour make them genuinely versatile.",
      date: "2026-07-25",
    },
  ],
  "jet-black-straight-fit": [
    {
      author: "Ritesh Kadam",
      rating: 5,
      title: "True jet black",
      body: "Actually black, not the washed-out grey-black a lot of jeans turn out to be. The dry finish looks crisp. Three washes in and the colour is holding perfectly.",
      date: "2026-01-19",
    },
    {
      author: "Naveen Kumar",
      rating: 5,
      title: "Clean and versatile",
      body: "Works for both casual and slightly formal occasions. Slim through the leg with a straight fall — flattering without being skin tight.",
      date: "2026-03-22",
    },
    {
      author: "Faisal Ahmed",
      rating: 4,
      title: "Good fabric, break-in needed",
      body: "The dry denim is stiff out of the packet, as you would expect. After a week it moulds well. Fabric quality is clearly good and the stitching is tight everywhere.",
      date: "2026-05-30",
    },
    {
      author: "Ankit Trivedi",
      rating: 5,
      title: "Comfortable and smart",
      body: "Comfortable enough for a full day and looks sharp with a polo. The waistband sits well and doesn't dig in when seated.",
      date: "2026-07-08",
    },
    {
      author: "Pranav Shetty",
      rating: 4,
      title: "Repeat buyer",
      body: "Second pair of these. Consistent sizing and the same solid finish as the first — same deep black, same neat seams. No complaints.",
      date: "2026-08-09",
    },
  ],
  "slim-straight-fit-mud-brown": [
    {
      author: "Varun Chandra",
      rating: 5,
      title: "Unusual colour, brilliant in person",
      body: "The mud brown tint is a proper change from the usual blue and black — gets a comment every time I wear it. The vintage wash looks genuinely broken in rather than fake distressed.",
      date: "2026-03-05",
    },
    {
      author: "Suraj Pillai",
      rating: 5,
      title: "Slim through the thigh, straight below",
      body: "Exactly as described. Slim without clinging, then falls straight to the hem. The contrast tan stitching stands out beautifully against the brown.",
      date: "2026-05-11",
    },
    {
      author: "Aman Bhardwaj",
      rating: 4,
      title: "Lovely fabric, worth planning the pairing",
      body: "Fabric quality is excellent and the leather patch is a nice detail. It takes a bit more thought to style than plain denim, but with a cream or olive top it looks great.",
      date: "2026-06-30",
    },
    {
      author: "Rohan Dsouza",
      rating: 5,
      title: "Worth the limited edition tag",
      body: "Feels like a considered piece rather than a basic. Comfortable from the first wear and the finishing is spotless — no stray threads anywhere.",
      date: "2026-08-04",
    },
  ],
  "slim-straight-fit-mud-green": [
    {
      author: "Kunal Bansal",
      rating: 5,
      title: "Great olive-indigo tone",
      body: "The green cast over indigo is subtle — it reads as denim in most light and olive in daylight. Really well judged wash.",
      date: "2026-02-14",
    },
    {
      author: "Jatin Arora",
      rating: 5,
      title: "Comfortable slim straight",
      body: "Slim at the thigh with a straight hem, and there is enough give to move around in. Sizing was accurate at 34, no surprises.",
      date: "2026-04-11",
    },
    {
      author: "Vivek Choudhary",
      rating: 4,
      title: "Neat finish, natural-looking fades",
      body: "The faded thigh detail looks authentic rather than printed on. Stitching is even and the leather patch is properly sewn down. Slightly snug at first, settled after a couple of wears.",
      date: "2026-06-17",
    },
    {
      author: "Zaid Khan",
      rating: 4,
      title: "Different from everything else I own",
      body: "Wanted something other than blue and this delivered. The fabric is sturdy and the colour hasn't shifted after washing.",
      date: "2026-07-28",
    },
  ],
  "the-comfort-deep-black": [
    {
      author: "Mohit Bhagat",
      rating: 5,
      title: "Relaxed without looking baggy",
      body: "Plenty of room through the leg but it still looks intentional, not oversized. The soft denim is the highlight — breathable even in the afternoon heat.",
      date: "2026-01-31",
    },
    {
      author: "Anand Krishnan",
      rating: 5,
      title: "Most comfortable jeans I own",
      body: "Genuinely comfortable for long hours. The deep washed black goes with anything and hasn't faded unevenly at the knees or seat.",
      date: "2026-04-02",
    },
    {
      author: "Sourav Das",
      rating: 4,
      title: "Comfort-first fit",
      body: "If you want a slim look this isn't it — it's a proper relaxed cut, which is exactly what I wanted. The fabric is soft and the seams are well finished.",
      date: "2026-06-09",
    },
    {
      author: "Hemant Rawat",
      rating: 4,
      title: "Great for daily wear",
      body: "Wearing these most days now. Holds its shape well and the black hasn't gone grey. Solid stitching at the pockets and hem.",
      date: "2026-07-21",
    },
    {
      author: "Prashant Vora",
      rating: 4,
      title: "Roomy and breathable",
      body: "The relaxed leg plus the breathable fabric makes this ideal for long days out. The deep black still looks rich after a month of regular wear.",
      date: "2026-08-11",
    },
  ],
  "the-comfort-true-blue": [
    {
      author: "Nitin Salunkhe",
      rating: 5,
      title: "Honest indigo, easy fit",
      body: "The blue is a true, honest indigo — not overly bright and not too dark. Generous through the leg and very easy to wear all day.",
      date: "2026-02-27",
    },
    {
      author: "Rajat Kapoor",
      rating: 4,
      title: "Soft from the first wear",
      body: "No break-in period at all. The hand-feel is soft and it has only improved after a few washes. Waist true to size.",
      date: "2026-04-24",
    },
    {
      author: "Bhavesh Thakkar",
      rating: 4,
      title: "Roomy and comfortable",
      body: "Very comfortable, though it does run relaxed so order with that in mind. Stitching is clean and the hardware feels solid.",
      date: "2026-06-25",
    },
    {
      author: "Ravi Subramanian",
      rating: 4,
      title: "Ages nicely",
      body: "Bought these a few months back and the indigo has softened exactly the way good denim should. Looks better now than when it arrived.",
      date: "2026-08-07",
    },
  ],
  "vintage-blue-straight-fit": [
    {
      author: "Akash Bora",
      rating: 5,
      title: "Lived-in from day one",
      body: "The fading and whiskering look properly natural — nobody would guess these were new. The warm contrast stitching adds to the vintage feel.",
      date: "2026-03-18",
    },
    {
      author: "Chirag Solanki",
      rating: 5,
      title: "Good slim fit",
      body: "Slim through the leg with a clean straight fall. Comfortable to sit in, no pinching at the waist. Size 32 fit as expected.",
      date: "2026-05-06",
    },
    {
      author: "Devansh Mishra",
      rating: 3,
      title: "Lovely wash, denim is on the sturdier side",
      body: "The wash is genuinely nice and the stitching is tidy. The fabric is heavier than I expected though, and it took three or four wears before it softened up. Good jean, just be ready for the break-in.",
      date: "2026-07-02",
    },
    {
      author: "Lokesh Yadav",
      rating: 5,
      title: "Great everyday jean",
      body: "This has become my default. The colour is versatile, the fit is flattering, and the finishing is neat throughout.",
      date: "2026-08-12",
    },
  ],

  // ── T-Shirts ─────────────────────────────────────────────────────────────
  "black-cotton-tshirt": [
    {
      author: "Shreyas Pawar",
      rating: 5,
      title: "Sharp contrast collar",
      body: "The off-white collar and cuffs against the black look really smart — it lifts this above a plain polo. The cotton is soft and holds its shape after washing.",
      date: "2026-02-11",
    },
    {
      author: "Kabir Sinha",
      rating: 5,
      title: "Great everyday polo",
      body: "Fits well at M, neither boxy nor tight. The collar stays upright and hasn't curled at the edges. Placket stitching is neat.",
      date: "2026-04-16",
    },
    {
      author: "Arnav Kulkarni",
      rating: 4,
      title: "Good fabric, order true to size",
      body: "The cotton feels premium and breathable. I would say it runs true to size — I took L and it fits as expected. The black hasn't faded so far.",
      date: "2026-06-22",
    },
    {
      author: "Rishi Nagpal",
      rating: 4,
      title: "Looks polished with denim",
      body: "Pairs perfectly with jeans for an easy smart-casual look. The chest branding is subtle, which I appreciate.",
      date: "2026-08-01",
    },
  ],
  "white-cotton-tshirt": [
    {
      author: "Aryan Kohli",
      rating: 5,
      title: "Crisp white, breathable",
      body: "Genuinely breathable cotton — comfortable even in the afternoon. The white is clean and bright rather than off-white.",
      date: "2026-01-24",
    },
    {
      author: "Tushar Jain",
      rating: 5,
      title: "Great regular fit",
      body: "The regular fit is well judged — comfortable through the chest without looking loose. The collar holds its shape nicely.",
      date: "2026-03-27",
    },
    {
      author: "Neeraj Pandey",
      rating: 4,
      title: "Soft fabric, needs care as any white does",
      body: "Fabric quality is very good and soft against the skin. As with any white tee you have to be careful with stains, but it has washed up clean every time.",
      date: "2026-05-28",
    },
    {
      author: "Vishal Rana",
      rating: 4,
      title: "Wardrobe staple",
      body: "Simple, well made and goes with everything. The seams and placket stitching are all neat.",
      date: "2026-07-15",
    },
    {
      author: "Yogesh Barot",
      rating: 5,
      title: "Clean and well made",
      body: "A simple polo done properly. Collar, placket, shoulder seams — everything is neatly finished, and there has been no shrinkage after several washes.",
      date: "2026-08-16",
    },
  ],
  "white-cotton-lycra-tshirt": [
    {
      author: "Dhruv Sethi",
      rating: 5,
      title: "The stretch makes the difference",
      body: "The lycra gives it enough give to be far more comfortable than a rigid cotton polo. The contrast detailing on the collar looks refined.",
      date: "2026-02-19",
    },
    {
      author: "Omkar Nair",
      rating: 4,
      title: "Fits beautifully",
      body: "Sits close without clinging. The sleeves end at the right point on the arm. Very happy with the overall finish.",
      date: "2026-04-29",
    },
    {
      author: "Saurabh Dixit",
      rating: 4,
      title: "Comfortable, slightly fitted",
      body: "Comfortable stretch fabric and a clean white finish. It is a slightly closer fit than a standard cotton tee, so size up if you prefer a looser drape.",
      date: "2026-06-11",
    },
    {
      author: "Kartik Menon",
      rating: 4,
      title: "Holds up well",
      body: "Several washes in and there is no pilling or loss of stretch. The stitching at the cuffs is still perfect.",
      date: "2026-08-06",
    },
  ],
  "blue-cotton-lycra-tshirt": [
    {
      author: "Ishaan Bedi",
      rating: 5,
      title: "Deep navy, great stretch",
      body: "The navy is rich and looks more expensive than it is. The stretch makes it very easy to wear for a full day.",
      date: "2026-03-09",
    },
    {
      author: "Aniket Gokhale",
      rating: 5,
      title: "Comfortable regular fit",
      body: "Regular fit with just enough room through the chest. Soft against the skin and the collar keeps its shape.",
      date: "2026-05-19",
    },
    {
      author: "Farhan Ansari",
      rating: 3,
      title: "Nice fabric and colour, longer in the body",
      body: "The cotton-lycra blend feels good quality and the navy hasn't faded at all. It is noticeably longer in the body than I expected though — fine tucked in, less so untucked.",
      date: "2026-07-06",
    },
    {
      author: "Mayank Grover",
      rating: 5,
      title: "Easy with denim",
      body: "Pairs really well with lighter jeans. Neat button placket and clean stitching all round.",
      date: "2026-08-14",
    },
  ],
  "red-cotton-lycra-tshirt": [
    {
      author: "Sagar Wagh",
      rating: 5,
      title: "Bold red, no bleeding",
      body: "I was worried a bright red would run in the wash — it hasn't at all. The colour is still as vivid as day one.",
      date: "2026-02-05",
    },
    {
      author: "Aakash Rastogi",
      rating: 5,
      title: "Comfortable stretch",
      body: "The stretch fabric is really comfortable and moves with you. The regular fit is accurate at L.",
      date: "2026-04-14",
    },
    {
      author: "Rohit Bhalla",
      rating: 4,
      title: "Striking colour",
      body: "The red is bright and eye-catching — more of a statement piece than an everyday basic. Fabric quality and stitching are both good.",
      date: "2026-06-19",
    },
  ],
  "sky-blue-cotton-tshirt": [
    {
      author: "Parth Vasa",
      rating: 5,
      title: "Perfect for summer",
      body: "The light colour and breathable cotton make this ideal for hot days. Soft and comfortable straight out of the pack.",
      date: "2026-03-24",
    },
    {
      author: "Vinay Hegde",
      rating: 5,
      title: "Lovely shade",
      body: "The sky blue is soft and easy on the eye — it looks great in daylight. Fits true to size at M.",
      date: "2026-05-08",
    },
    {
      author: "Adarsh Menon",
      rating: 3,
      title: "Comfortable and light, thinner than expected",
      body: "The stitching is neat and the collar sits well. The fabric is thinner than the other cotton tees here, which suits summer but does mean it is a little see-through in bright light.",
      date: "2026-06-27",
    },
    {
      author: "Tarun Vaidya",
      rating: 4,
      title: "Easy everyday tee",
      body: "Goes with denim of any wash. Washed it several times with no shrinkage at all.",
      date: "2026-08-10",
    },
  ],
  "denim-blue-cotton-tshirt": [
    {
      author: "Kaushik Sen",
      rating: 5,
      title: "Great denim-blue tone",
      body: "The shade sits somewhere between navy and sky, which makes it really versatile. The cotton is soft and substantial.",
      date: "2026-01-29",
    },
    {
      author: "Amit Lohia",
      rating: 5,
      title: "Well fitted",
      body: "The regular fit is comfortable through the shoulders and chest. Collar holds its shape and hasn't curled after washing.",
      date: "2026-04-08",
    },
    {
      author: "Sanjay Bhosale",
      rating: 4,
      title: "Good quality cotton",
      body: "The fabric feels durable and the stitching is even throughout. Colour has held after multiple washes. Slightly warm for peak summer, but excellent otherwise.",
      date: "2026-06-03",
    },
    {
      author: "Raghav Anand",
      rating: 5,
      title: "Understated and smart",
      body: "Subtle branding and a clean silhouette — exactly what I wanted. Pairs nicely with light-wash jeans.",
      date: "2026-07-31",
    },
  ],
  "bottle-green-cotton-tshirt": [
    {
      author: "Ayush Bagchi",
      rating: 5,
      title: "Rich bottle green",
      body: "The green is deep and refined rather than loud. The contrast collar detailing looks sharp against it.",
      date: "2026-02-24",
    },
    {
      author: "Girish Nambiar",
      rating: 4,
      title: "Soft and comfortable",
      body: "Premium-feeling cotton, soft from the first wear. The regular fit is accurate at XL.",
      date: "2026-05-01",
    },
    {
      author: "Mihir Purohit",
      rating: 4,
      title: "Nice colour, neat stitching",
      body: "Colour is exactly as pictured and the stitching around the collar and cuffs is clean. The fabric is on the slightly heavier side, which I like.",
      date: "2026-06-15",
    },
  ],
  "wood-rose-cotton-lycra-tshirt": [
    {
      author: "Aditya Ranganathan",
      rating: 5,
      title: "Subtle lavender, very wearable",
      body: "I was unsure about the colour online but it is a muted lavender that works surprisingly well. Not loud at all.",
      date: "2026-03-12",
    },
    {
      author: "Kunal Fernandes",
      rating: 5,
      title: "Comfortable stretch fabric",
      body: "The cotton-lycra makes it soft and flexible. Fits well at M with enough room to move.",
      date: "2026-05-21",
    },
    {
      author: "Rakesh Jhaveri",
      rating: 4,
      title: "Good finish, distinctive colour",
      body: "The contrast detailing on the collar and cuffs is well done and the stitching is tidy. The lavender is distinctive so it won't suit every occasion, but I like it.",
      date: "2026-07-04",
    },
  ],
};

async function main() {
  console.log("🌱 Seeding sample product reviews into Supabase…\n");

  // 1. Reviews key off product handles, so read the live catalog first.
  const { data: products, error: pErr } = await supabaseAdmin
    .from("products")
    .select("handle")
    .order("handle");
  if (pErr) throw pErr;
  const handles = (products ?? []).map((p) => p.handle as string);

  const missing = handles.filter((h) => !REVIEWS[h]?.length);
  if (missing.length) {
    throw new Error(
      `No sample reviews defined for: ${missing.join(", ")}. Add them to REVIEWS and re-run.`,
    );
  }
  const unknown = Object.keys(REVIEWS).filter((h) => !handles.includes(h));
  if (unknown.length) console.log(`ℹ skipping handles with no product: ${unknown.join(", ")}\n`);

  // 2. Upsert the reviews. Deterministic ids keep this safe to re-run.
  const rows = handles.flatMap((handle) =>
    REVIEWS[handle].map((r, i) => ({
      id: reviewId(handle, i),
      product_handle: handle,
      author: r.author,
      rating: r.rating,
      title: r.title,
      body: r.body,
      images: [] as string[],
      created_at: new Date(`${r.date}T10:00:00.000Z`).toISOString(),
    })),
  );
  const { error: rErr } = await supabaseAdmin.from("reviews").upsert(rows, { onConflict: "id" });
  if (rErr) throw rErr;
  console.log(`✔ reviews (${rows.length} across ${handles.length} products)\n`);

  // 3. Recompute rating + review_count per product from the reviews table —
  //    mirrors refreshProductAggregate() in reviews.controller.ts.
  for (const handle of handles) {
    const { data, error } = await supabaseAdmin
      .from("reviews")
      .select("rating")
      .eq("product_handle", handle);
    if (error) throw error;
    const ratings = (data ?? []).map((r) => r.rating as number);
    const count = ratings.length;
    const average = count ? Math.round((ratings.reduce((s, n) => s + n, 0) / count) * 10) / 10 : 0;
    const { error: uErr } = await supabaseAdmin
      .from("products")
      .update({ rating: average, review_count: count })
      .eq("handle", handle);
    if (uErr) throw uErr;
    console.log(`  ${handle.padEnd(32)} ${String(count).padStart(2)} reviews · ${average.toFixed(1)}★`);
  }

  console.log("\n✅ Review seed complete.");
}

main().catch((err) => {
  console.error("\n❌ Review seed failed:", err.message ?? err);
  process.exit(1);
});
