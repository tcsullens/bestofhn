import { stemmer } from "stemmer";

// English stopwords plus conversational filler that shows up in nearly every HN thread.
const STOPWORDS = new Set(
  `a about above after again against all almost also although always am among an and another any anyone anything are aren't
  around as at away back be because been before being below between both but by can can't cannot could couldn't did didn't
  do does doesn't doing don't done down during each either else enough etc even ever every everyone everything few for from
  further get gets getting go goes going gone got had hadn't has hasn't have haven't having he he'd he'll he's her here here's
  hers herself him himself his how how's however i i'd i'll i'm i've if in instead into is isn't it it'd it'll it's its itself
  just least less let let's like likely lot lots made make makes making many may maybe me might mine more most much must
  mustn't my myself near need needs neither never no nobody none nor not nothing now of off often oh ok okay on once one ones
  only onto or other others otherwise ought our ours ourselves out over own per perhaps please quite rather re really right
  said same say says see seem seems seen shall shan't she she'd she'll she's should shouldn't since so some someone something
  sometimes somewhat still such sure take than that that's the their theirs them themselves then there there's therefore
  these they they'd they'll they're they've thing things think this those though through thus to too toward towards
  under unless until up upon us use used uses using very via vs want wants was wasn't way ways we we'd we'll we're we've well
  were weren't what what's whatever when when's where where's whether which while who who's whoever whole whom whose why why's
  will with within without won't would wouldn't yeah yes yet you you'd you'll you're you've your yours yourself yourselves
  actually anyway basically certainly definitely especially exactly generally good great kind know literally mean means
  people pretty probably simply sort stuff thanks thank totally true yep nope
  e.g i.e eg ie imo imho iirc afaik fwiw tbh lol dont doesnt didnt isnt wasnt cant wont wouldnt shouldnt couldnt im ive
  id youre theyre thats theres whats lets http https www com html`.split(/\s+/),
);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Comment HTML (as returned by Algolia) to plain text. */
export function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "));
}

/** Lowercased content words from an HN comment. Keeps tech tokens like c++, c#, node.js, h1b. */
export function tokenize(html: string): string[] {
  const text = plainText(html)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/https?:\/\/\S+/g, " ");
  const words: string[] = [];
  for (let w of text.match(/[a-z][a-z0-9'+#.-]*[a-z0-9+#]/g) ?? []) {
    w = w.replace(/'s$/, "");
    if (w.length > 1 && !STOPWORDS.has(w) && !w.includes("'")) words.push(w);
  }
  return words;
}

/** [stem, number of comments mentioning it, most common surface form] */
export type Term = [stem: string, count: number, display: string];

/**
 * Per-thread term counts. Each word counts once per comment, so one person repeating a word doesn't dominate.
 * Stems merge plural/inflected forms (model/models); the most frequent surface form is kept for display.
 */
export function threadTerms(comments: string[], limit = 60): Term[] {
  const counts = new Map<string, number>();
  const surfaces = new Map<string, Map<string, number>>();
  for (const comment of comments) {
    const seen = new Set<string>();
    for (const word of tokenize(comment)) {
      const stem = /^[a-z]+$/.test(word) ? stemmer(word) : word;
      const forms = surfaces.get(stem) ?? new Map<string, number>();
      forms.set(word, (forms.get(word) ?? 0) + 1);
      surfaces.set(stem, forms);
      if (!seen.has(stem)) {
        seen.add(stem);
        counts.set(stem, (counts.get(stem) ?? 0) + 1);
      }
    }
  }
  return [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([stem, n]) => [stem, n, mostCommon(surfaces.get(stem)!)]);
}

function mostCommon(forms: Map<string, number>): string {
  let best = "";
  let bestN = 0;
  for (const [form, n] of forms) if (n > bestN) [best, bestN] = [form, n];
  return best;
}
