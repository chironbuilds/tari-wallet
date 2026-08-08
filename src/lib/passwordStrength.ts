// Password-strength check for the vault password (Create/Import screens). Flagged as a residual
// risk in SECURITY_AUDIT.md §7 ("no strength meter or dictionary check") -- this addresses both,
// no dependency (a real dictionary-check library like zxcvbn's is ~800KB+ of frequency tables,
// disproportionate to a wallet extension's bundle budget for what's fundamentally a length +
// blocklist + pattern check).
//
// Design follows current guidance (NIST SP 800-63B) over older composition-rule advice: length and
// "is this actually guessable" matter far more than forcing a digit/symbol/uppercase mix, which
// mostly just trains people into predictable substitutions ("password" -> "P@ssw0rd1"). So:
//   - `isBlocked()` is the only hard gate -- an exact match against known-common passwords, or a
//     password that's essentially just a repeated/sequential/keyboard-walk pattern. Both are
//     guessable in the first few thousand attempts of any real cracking attempt regardless of
//     length, so no amount of padding earns them back.
//   - `estimateStrength()` is advisory only (drives the meter) -- a crude entropy estimate from
//     character-class variety and length, not a full crack-time model.

// A curated subset of the passwords that show up at the top of every public breach-derived
// "most common passwords" list (RockYou, SplashData/NordPass annual lists, the UK NCSC's
// top-100k list, etc.) -- not exhaustive (that's thousands of entries and a network fetch or a
// large bundled file this wallet doesn't need), just enough to catch the passwords someone would
// actually type first. All lowercase; matching is case-insensitive.
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567",
  "dragon", "123123", "baseball", "abc123", "football", "monkey", "letmein", "696969", "shadow",
  "master", "666666", "qwertyuiop", "123321", "mustang", "1234567890", "michael", "654321",
  "superman", "1qaz2wsx", "7777777", "121212", "000000", "qazwsx", "123qwe", "killer", "trustno1",
  "jordan", "jennifer", "zxcvbnm", "asdfgh", "hunter", "buster", "soccer", "harley", "batman",
  "andrew", "tigger", "sunshine", "iloveyou", "charlie", "robert", "thomas", "hockey", "ranger",
  "daniel", "starwars", "112233", "george", "computer", "michelle", "jessica", "pepper", "1111",
  "zzzzzz", "ginger", "princess", "joshua", "cheese", "amanda", "summer", "ashley", "6969",
  "nicole", "chelsea", "matthew", "access", "yankees", "987654321", "dallas", "austin", "thunder",
  "taylor", "matrix", "welcome", "admin", "admin123", "letmein1", "passw0rd", "password1",
  "password123", "qwerty123", "1q2w3e4r", "1q2w3e", "aa123456", "abcd1234", "iloveyou1",
  "myspace1", "blink182", "flower", "hottie", "loveme", "hello", "freedom", "whatever", "test",
  "test123", "guest", "root", "toor", "changeme", "default", "letmein123", "121212123",
  "11111111", "88888888", "qwer1234", "1qazxsw2", "trustno1123", "welcome1", "monkey123",
  "football1", "baseball1", "dragon123", "master123", "shadow123", "superman123", "batman123",
  "spiderman", "startrek", "starwars1", "pokemon", "pikachu", "minecraft", "fuckoff", "asdfasdf",
  "asdf1234", "123abc", "abc12345", "p@ssw0rd", "p@ssword", "passw0rd1", "changeme123",
  "letmeinplease", "wordpass",
]);

/** True if `s` (letters or digits only) is a straight ascending/descending run, e.g. "abcdef",
 * "87654321", "hgfedcba" -- checked over the whole string, since a run embedded in a longer,
 * otherwise-random password isn't the same risk as the whole password being one. */
function isSequentialRun(s: string): boolean {
  if (s.length < 4) return false;
  const codes = [...s.toLowerCase()].map((c) => c.charCodeAt(0));
  const ascending = codes.every((c, i) => i === 0 || c === codes[i - 1]! + 1);
  const descending = codes.every((c, i) => i === 0 || c === codes[i - 1]! - 1);
  return ascending || descending;
}

/** True if `s` is a single character repeated the whole way through, e.g. "aaaaaaaa". */
function isRepeatedChar(s: string): boolean {
  return s.length >= 4 && [...s].every((c) => c === s[0]);
}

// A handful of common keyboard-row walks (QWERTY, both directions, with and without the shift-row
// digits) -- these have effectively zero real entropy despite "looking" varied.
const KEYBOARD_RUNS = [
  "qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "qazwsx", "wsxedc", "1qaz2wsx3edc",
];
function isKeyboardWalk(s: string): boolean {
  const lower = s.toLowerCase();
  return KEYBOARD_RUNS.some((run) => run.includes(lower) || [...run].reverse().join("").includes(lower));
}

const LEET_MAP: Record<string, string> = { "@": "a", $: "s", "0": "o", "1": "i", "3": "e", "4": "a", "5": "s" };

/** Cheap variants of `lower` that a determined guesser (and any real cracking tool) tries before
 * anything cleverer: with leet substitutions reversed, with punctuation stripped entirely, and
 * with trailing digits (a year, a "1", ...) dropped -- in every combination, since which
 * transform applies first isn't consistent (`p@ssw0rd` needs the leet map to become recognizable;
 * `password1!` is already a listed entry once trailing punctuation is gone). */
function guessableVariants(lower: string): string[] {
  const leet = [...lower].map((c) => LEET_MAP[c] ?? c).join("");
  const stripPunct = (s: string) => s.replace(/[^a-z0-9]/g, "");
  const stripTrailingDigits = (s: string) => s.replace(/[0-9]+$/, "");
  const base = [lower, stripPunct(lower), leet, stripPunct(leet)];
  return [...new Set([...base, ...base.map(stripTrailingDigits)])].filter((v) => v.length > 0);
}

/** The only hard gate: an exact (or trivially-disguised) match on a known-common password, or the
 * whole password being a repeated/sequential/keyboard-walk pattern. Padding a blocked password
 * with extra characters (`password123!!!`) does NOT get it unblocked here on purpose -- real
 * cracking tools try exactly these mutations first, so the extra length buys nothing. */
export function isBlockedPassword(password: string): boolean {
  const trimmed = password.trim();
  if (trimmed.length === 0) return false;
  if (guessableVariants(trimmed.toLowerCase()).some((v) => COMMON_PASSWORDS.has(v))) return true;
  return isSequentialRun(trimmed) || isRepeatedChar(trimmed) || isKeyboardWalk(trimmed);
}

export interface PasswordStrength {
  /** 0 = very weak, 4 = strong. Purely advisory (drives the meter); only `isBlockedPassword`
   * actually gates submission. */
  score: 0 | 1 | 2 | 3 | 4;
  label: "Very weak" | "Weak" | "Fair" | "Good" | "Strong";
  /** Short, actionable tips for anything short of "Strong" -- empty once there's nothing left to
   * suggest. */
  feedback: string[];
}

const LABELS: PasswordStrength["label"][] = ["Very weak", "Weak", "Fair", "Good", "Strong"];

/** A crude entropy estimate from character-class variety and length -- not a real crack-time
 * model (that needs a frequency-ranked dictionary this wallet doesn't ship), just enough signal to
 * tell "short and simple" from "long and varied" apart for the meter. */
export function estimatePasswordStrength(password: string): PasswordStrength {
  const feedback: string[] = [];
  if (password.length === 0) return { score: 0, label: "Very weak", feedback: [] };

  if (isBlockedPassword(password)) {
    return { score: 0, label: "Very weak", feedback: ["This is one of the most commonly used passwords — choose something less guessable."] };
  }

  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  pool = Math.max(pool, 1);

  const bits = password.length * Math.log2(pool);

  let score: PasswordStrength["score"];
  if (bits < 28) score = 0;
  else if (bits < 36) score = 1;
  else if (bits < 50) score = 2;
  else if (bits < 65) score = 3;
  else score = 4;

  if (password.length < 12) feedback.push("Longer passwords are much harder to guess than adding symbols to a short one.");
  if (pool < 36) feedback.push("Mixing letter case, numbers, or symbols helps, but length matters more.");
  if (score >= 4) feedback.length = 0;

  return { score, label: LABELS[score]!, feedback };
}
