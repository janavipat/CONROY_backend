/**
 * Canonical catalog used to seed Supabase. Mirrors the storefront's four denim
 * styles and three collections. Imagery references the brand's Shopify CDN.
 */
const CDN = "https://cdn.shopify.com/s/files/1/0763/6248/1899/files";

export interface SeedProduct {
  id: string;
  handle: string;
  title: string;
  tagline: string;
  description: string;
  color: "Black" | "Blue";
  fit: "Straight fit" | "Relax fit";
  price: number;
  currency: string;
  sizes: string[];
  details: string[];
  stock: number;
  rating: number;
  review_count: number;
  badge: string | null;
  images: { src: string; alt: string }[];
}

export interface SeedCollection {
  handle: string;
  title: string;
  subtitle: string;
  description: string;
  image: string;
  productHandles: string[];
}

export const PRODUCTS: SeedProduct[] = [
  {
    id: "black-straight",
    handle: "pants",
    title: "Black Straight Fit",
    tagline: "Premium soft-wash denim, clean straight leg.",
    description:
      "A refined denim piece featuring a straight-leg silhouette cut from premium soft-wash denim with modern fade detailing. Designed for all-day comfort — durable, versatile and effortlessly stylish.",
    color: "Black",
    fit: "Straight fit",
    price: 1799,
    currency: "INR",
    sizes: ["30", "32", "34", "36"],
    details: [
      "Mid-rise waist with button and zip fly",
      "Classic five-pocket construction",
      "Premium soft-wash denim weave",
      "Straight-leg silhouette",
      "Net Qty: 1",
    ],
    stock: 99,
    rating: 5,
    review_count: 1,
    badge: "Limited time",
    images: [
      { src: `${CDN}/3_3_jpg.jpg?v=1771951023`, alt: "Black Straight Fit denim — front" },
      { src: `${CDN}/3_1_jpg.jpg?v=1771951023`, alt: "Black Straight Fit denim — detail" },
      { src: `${CDN}/3_2_jpg.jpg?v=1771951023`, alt: "Black Straight Fit denim — side" },
      { src: `${CDN}/3_4_jpg.jpg?v=1771950996`, alt: "Black Straight Fit denim — back" },
      { src: `${CDN}/3_5_jpg.jpg?v=1771950999`, alt: "Black Straight Fit denim — fabric" },
    ],
  },
  {
    id: "blue-straight",
    handle: "black-pent",
    title: "Blue Straight Fit",
    tagline: "Heritage indigo with a tailored straight leg.",
    description:
      "An everyday indigo straight-fit cut from premium denim with a subtle, lived-in finish. Tailored through the leg for a clean line that pairs with everything — built to last and to soften beautifully over time.",
    color: "Blue",
    fit: "Straight fit",
    price: 1799,
    currency: "INR",
    sizes: ["30", "32", "34", "36"],
    details: [
      "Mid-rise waist with button and zip fly",
      "Classic five-pocket construction",
      "Premium indigo denim weave",
      "Straight-leg silhouette",
      "Net Qty: 1",
    ],
    stock: 99,
    rating: 5,
    review_count: 1,
    badge: "Limited time",
    images: [
      { src: `${CDN}/4_1_jpg.jpg?v=1771951309`, alt: "Blue Straight Fit denim — front" },
      { src: `${CDN}/4_2_jpg.jpg?v=1771951311`, alt: "Blue Straight Fit denim — detail" },
      { src: `${CDN}/4_3_jpg.jpg?v=1771951309`, alt: "Blue Straight Fit denim — side" },
      { src: `${CDN}/4_6_jpg.jpg?v=1771951309`, alt: "Blue Straight Fit denim — back" },
      { src: `${CDN}/4_4_jpg.jpg?v=1771951321`, alt: "Blue Straight Fit denim — fabric" },
      { src: `${CDN}/4_5_jpg.jpg?v=1771951325`, alt: "Blue Straight Fit denim — pocket" },
    ],
  },
  {
    id: "black-relax",
    handle: "the-comfort-deep-black",
    title: "Black Relax Fit",
    tagline: "Relaxed comfort in a deep, washed black.",
    description:
      "A relaxed-fit denim cut from soft, breathable fabric for ease of movement without losing its shape. Deep washed black with understated detailing — comfort that reads as quiet confidence.",
    color: "Black",
    fit: "Relax fit",
    price: 1499,
    currency: "INR",
    sizes: ["30", "32", "34", "36", "38"],
    details: [
      "Mid-rise waist with button and zip fly",
      "Classic five-pocket construction",
      "Soft, breathable denim",
      "Relaxed-leg silhouette",
      "Net Qty: 1",
    ],
    stock: 99,
    rating: 5,
    review_count: 1,
    badge: "Limited time",
    images: [
      { src: `${CDN}/1.1.jpg_2_f47254ce-4b73-4cfe-87d8-4fbf77e25ccd.jpg?v=1773538477`, alt: "Black Relax Fit denim — front" },
      { src: `${CDN}/1_2_jpg_6ea5d82a-e26e-49ce-93e6-5b86d8a876c3.jpg?v=1773384301`, alt: "Black Relax Fit denim — detail" },
      { src: `${CDN}/1_3_jpg_b1d230cc-ef77-4514-8d49-af62fac1496c.jpg?v=1773384301`, alt: "Black Relax Fit denim — side" },
      { src: `${CDN}/1_5_jpg_e9dbe0ae-3eb2-46bd-b6d1-fa7cfd7be230.jpg?v=1773384301`, alt: "Black Relax Fit denim — back" },
      { src: `${CDN}/1.4.jpg_2.jpg?v=1773384301`, alt: "Black Relax Fit denim — fabric" },
    ],
  },
  {
    id: "blue-relax",
    handle: "the-comfort-true-blue",
    title: "Blue Relax Fit",
    tagline: "True-blue denim, relaxed and easy.",
    description:
      "A true-blue relaxed-fit denim with generous room through the leg and a soft hand-feel. Honest indigo, thoughtfully finished — an everyday piece designed to move with you and age gracefully.",
    color: "Blue",
    fit: "Relax fit",
    price: 1499,
    currency: "INR",
    sizes: ["30", "32", "34", "36", "38"],
    details: [
      "Mid-rise waist with button and zip fly",
      "Classic five-pocket construction",
      "True-blue indigo denim",
      "Relaxed-leg silhouette",
      "Net Qty: 1",
    ],
    stock: 99,
    rating: 5,
    review_count: 1,
    badge: "Limited time",
    images: [
      { src: `${CDN}/2_7_jpg.jpg?v=1771950828`, alt: "Blue Relax Fit denim — front" },
      { src: `${CDN}/2_1_jpg.jpg?v=1771950829`, alt: "Blue Relax Fit denim — detail" },
      { src: `${CDN}/2_2_jpg.jpg?v=1771950831`, alt: "Blue Relax Fit denim — side" },
      { src: `${CDN}/2_3_jpg.jpg?v=1771950832`, alt: "Blue Relax Fit denim — back" },
      { src: `${CDN}/2_4_jpg.jpg?v=1771950832`, alt: "Blue Relax Fit denim — fabric" },
      { src: `${CDN}/2_5_jpg.jpg?v=1771950832`, alt: "Blue Relax Fit denim — pocket" },
      { src: `${CDN}/2_6_jpg.jpg?v=1771950831`, alt: "Blue Relax Fit denim — hem" },
    ],
  },
];

export const COLLECTIONS: SeedCollection[] = [
  {
    handle: "all",
    title: "All Products",
    subtitle: "The full collection",
    description:
      "Every CONROY style in one place — straight and relaxed denim in heritage indigo and washed black, made to last.",
    image: PRODUCTS[0].images[0].src,
    productHandles: PRODUCTS.map((p) => p.handle),
  },
  {
    handle: "romano-fit-noir-classique",
    title: "Romano Fit · Noir Classique",
    subtitle: "Washed black denim",
    description:
      "Our Noir Classique line — deep washed black denim in straight and relaxed fits. Restrained, refined, endlessly wearable.",
    image: PRODUCTS[0].images[0].src,
    productHandles: ["pants", "the-comfort-deep-black"],
  },
  {
    handle: "romano-fit-bleu-heritage",
    title: "Romano Fit · Bleu Heritage",
    subtitle: "Heritage indigo denim",
    description:
      "Bleu Heritage — true-blue indigo denim in straight and relaxed fits, finished to soften and age with character.",
    image: PRODUCTS[3].images[0].src,
    productHandles: ["black-pent", "the-comfort-true-blue"],
  },
];
