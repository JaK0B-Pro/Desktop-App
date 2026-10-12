/** Amounts in words, as written on cheques and vouchers. French follows the traditional spelling. */

const FR_UNITS = [
  "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
  "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
];
const FR_TENS = ["", "dix", "vingt", "trente", "quarante", "cinquante", "soixante"];

/** 0..99. `plural`: "quatre-vingts" takes an s only when nothing (or a noun like million) follows. */
function frBelow100(n: number, plural: boolean): string {
  if (n < 17) return FR_UNITS[n];
  if (n < 20) return `dix-${FR_UNITS[n - 10]}`;
  const tens = Math.floor(n / 10);
  const u = n % 10;
  if (tens === 7) return u === 1 ? "soixante et onze" : `soixante-${frBelow100(10 + u, plural)}`;
  if (tens === 8) return u === 0 ? (plural ? "quatre-vingts" : "quatre-vingt") : `quatre-vingt-${FR_UNITS[u]}`;
  if (tens === 9) return `quatre-vingt-${frBelow100(10 + u, plural)}`;
  if (u === 0) return FR_TENS[tens];
  if (u === 1) return `${FR_TENS[tens]} et un`;
  return `${FR_TENS[tens]}-${FR_UNITS[u]}`;
}

function frBelow1000(n: number, plural: boolean): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h === 1) parts.push("cent");
  else if (h > 1) parts.push(`${FR_UNITS[h]} cent${r === 0 && plural ? "s" : ""}`);
  if (r > 0 || h === 0) parts.push(frBelow100(r, plural));
  return parts.join(" ");
}

export function numberToFrench(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "zéro";
  const parts: string[] = [];
  const big: [number, string, string][] = [
    [1e9, "milliard", "milliards"],
    [1e6, "million", "millions"],
  ];
  for (const [size, one, many] of big) {
    const g = Math.floor(n / size);
    if (g > 0) parts.push(g === 1 ? `un ${one}` : `${frBelow1000(g, true)} ${many}`);
    n %= size;
  }
  const thousands = Math.floor(n / 1000);
  if (thousands === 1) parts.push("mille");
  else if (thousands > 1) parts.push(`${frBelow1000(thousands, false)} mille`);
  const rest = n % 1000;
  if (rest > 0) parts.push(frBelow1000(rest, true));
  return parts.join(" ");
}

const EN_UNITS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function enBelow1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${EN_UNITS[h]} hundred`);
  if (r > 0) {
    const t = r < 20 ? EN_UNITS[r] : EN_TENS[Math.floor(r / 10)] + (r % 10 ? `-${EN_UNITS[r % 10]}` : "");
    parts.push(h > 0 ? `and ${t}` : t);
  }
  return parts.join(" ");
}

export function numberToEnglish(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "zero";
  const parts: string[] = [];
  for (const [size, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as [number, string][]) {
    const g = Math.floor(n / size);
    if (g > 0) parts.push(`${enBelow1000(g)} ${name}`);
    n %= size;
  }
  if (n > 0) parts.push(enBelow1000(n));
  return parts.join(" ");
}

/**
 * "Huit mille deux cent quatre-vingt-huit dinars et cinquante centimes".
 * `currency`/`subunit` are plural names; the trailing "s" is dropped for exactly one.
 */
export function amountInWords(
  cents: number,
  decimals: number,
  lang: "fr" | "en",
  currency: string,
  subunit: string,
): string {
  const div = 10 ** decimals;
  const whole = Math.floor(Math.abs(cents) / div);
  const frac = Math.abs(cents) % div;
  const toWords = lang === "fr" ? numberToFrench : numberToEnglish;
  const unit = (n: number, name: string) => (n === 1 ? name.replace(/s$/, "") : name);
  let words = toWords(whole);
  // "un million de dinars", "deux milliards de dinars"
  const de = lang === "fr" && whole > 0 && whole % 1e6 === 0 ? "de " : "";
  words = `${words} ${de}${unit(whole, currency)}`.trim();
  if (frac > 0 && subunit) words += ` ${lang === "fr" ? "et" : "and"} ${toWords(frac)} ${unit(frac, subunit)}`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
