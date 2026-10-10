const PAGE = 30;
const WINDOW_DAYS = { "24h": 1, "1w": 7, "1m": 30, "1y": 365 };
const DEFAULTS = { w: "24h", s: "points", t: "all", tag: "", compare: "" };

let data;
let byId;
let shown = PAGE;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// View state lives in the URL hash so any view can be bookmarked or shared.
function getState() {
  const params = new URLSearchParams(location.hash.slice(1));
  return Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, params.get(k) ?? v]));
}

function setState(patch) {
  const state = { ...getState(), ...patch };
  const params = new URLSearchParams(Object.entries(state).filter(([k, v]) => v !== DEFAULTS[k]));
  location.hash = params.toString();
}

function ago(seconds) {
  const s = Date.now() / 1000 - seconds;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function domain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function renderPost(post, rank, activeTag, compare) {
  const hn = `https://news.ycombinator.com/item?id=${post.id}`;
  const link = post.url && /^https?:/.test(post.url) ? post.url : hn;
  const host = post.url ? domain(post.url) : "";
  const tags = post.tags
    .map((t) => `<button class="tag${t === activeTag ? " active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`)
    .join("");
  return `<li>
    <span class="rank">${rank}.</span>
    <div>
      <a class="title" href="${esc(link)}">${esc(post.title)}</a>${host ? `<span class="domain">(${esc(host)})</span>` : ""}
      <div class="meta">
        <span>${post.points} points · <a href="${hn}">${post.comments} comments</a> · by ${esc(post.author)} · ${ago(post.time)}</span>
        ${tags ? `<span class="tags">${tags}</span>` : ""}
      </div>
      ${compare && post.variants ? renderVariants(post.variants) : ""}
    </div>
  </li>`;
}

// Trial view: every tagger's output side by side.
function renderVariants(variants) {
  const rows = Object.entries(variants).map(
    ([name, tags]) =>
      `<div class="variant"><span class="variant-name">${esc(name)}</span>${tags.map((t) => `<span class="tag plain">${esc(t)}</span>`).join("") || `<span class="muted">—</span>`}</div>`,
  );
  return `<div class="variants">${rows.join("")}</div>`;
}

function render() {
  const { w, s, t, tag, compare } = getState();
  for (const seg of document.querySelectorAll(".seg[data-key]")) {
    const current = { w, s, t }[seg.dataset.key];
    for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.value === current));
  }

  const list = data.lists[w]?.[s]?.[t];
  const ids = Array.isArray(list) ? list : []; // hash values like "constructor" resolve to inherited properties
  const posts = ids.map((id) => byId.get(id)).filter((p) => p && (!tag || p.tags.includes(tag)));

  $("#filter").hidden = !tag;
  $("#filter").innerHTML = tag
    ? `${posts.length} post${posts.length === 1 ? "" : "s"} tagged <button class="tag active" data-clear>${esc(tag)} ×</button>`
    : "";

  const windowStart = data.generatedAt - WINDOW_DAYS[w] * 86400;
  const partial = data.oldest && data.oldest > windowStart + 86400;
  $("#coverage").hidden = !partial;
  if (partial)
    $("#coverage").textContent = `Data currently goes back to ${new Date(data.oldest * 1000).toLocaleDateString()}.`;

  $("#compare").hidden = !data.posts.some((p) => p.variants);
  $("#compare").setAttribute("aria-pressed", String(Boolean(compare)));
  $("#posts").innerHTML =
    posts
      .slice(0, shown)
      .map((p, i) => renderPost(p, i + 1, tag, compare))
      .join("") || `<p class="muted">No posts.</p>`;
  $("#more").hidden = posts.length <= shown;
}

document.addEventListener("click", (e) => {
  const segButton = e.target.closest(".seg[data-key] button");
  if (segButton) return setState({ [segButton.parentElement.dataset.key]: segButton.value });
  if (e.target.closest("[data-clear]")) return setState({ tag: "" });
  const tag = e.target.closest(".tag[data-tag]");
  if (tag) {
    const current = getState().tag;
    setState({ tag: tag.dataset.tag === current ? "" : tag.dataset.tag });
    window.scrollTo({ top: 0 });
  }
});

// Theme: "system" (no stored choice; CSS follows prefers-color-scheme), "light" or "dark".
function syncThemeControl() {
  const current = document.documentElement.dataset.theme ?? "system";
  for (const b of $("#theme").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.value === current));
}

$("#theme").addEventListener("click", (e) => {
  const choice = e.target.closest("button")?.value;
  if (!choice) return;
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", choice);
  } catch {}
  syncThemeControl();
});
syncThemeControl();

$("#compare").addEventListener("click", () => setState({ compare: getState().compare ? "" : "1" }));

$("#more").addEventListener("click", () => {
  shown += PAGE;
  render();
});

window.addEventListener("hashchange", () => {
  shown = PAGE;
  render();
});

fetch("/data.json")
  .then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  })
  .then((d) => {
    data = d;
    byId = new Map(d.posts.map((p) => [p.id, p]));
    $("#status").textContent = `Updated ${ago(d.generatedAt)} · ${d.posts.length.toLocaleString()} posts`;
    render();
  })
  .catch((err) => {
    $("#status").textContent = `Couldn't load data: ${err.message}`;
  });
