// Builds the results DOM. Everything from the engine is untrusted text: it only ever goes through
// textContent, image URLs and links are checked to be https, and nothing is ever inserted as HTML.

import { estimates, gbp, ESTIMATE_LABEL } from "./finance.js";

export const ZUTO_QUOTE_URL = "https://www.zuto.com/apply/";

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function isHttps(url) {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function safeLink(url, text, className) {
  if (!isHttps(url)) return el("span", { class: className, text });
  return el("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: className, text });
}

export function fmtTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

export function fmtDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function stated(value) {
  return value && value !== "not stated" ? String(value) : "";
}

function swatchClass(finish) {
  if (finish === "Factory matte" || finish === "Matte wrap") return "swatch";
  if (finish === "Satin") return "swatch satin";
  if (finish === "Not matte") return "swatch gloss";
  return "swatch unknown";
}

export function sortListings(listings, sortBy) {
  const copy = [...listings];
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Infinity);
  if (sortBy === "price") copy.sort((a, b) => num(a.price_gbp) - num(b.price_gbp));
  else if (sortBy === "mileage") copy.sort((a, b) => num(a.mileage) - num(b.mileage));
  else if (sortBy === "distance") copy.sort((a, b) => num(a.distance_miles) - num(b.distance_miles));
  return copy; // "value": the engine's ranking
}

export function carCard(car, search) {
  const title = [car.year, stated(car.make), stated(car.model)].filter(Boolean).join(" ") || stated(car.title) || "Car";
  const variant = stated(car.variant);
  const engine = [stated(car.engine_litres) && `${stated(car.engine_litres)} L`, stated(car.power)].filter(Boolean).join(", ");
  const badges = [];
  if (car.change && car.change.kind === "new") badges.push(el("span", { class: "badge new", text: "New" }));
  if (car.change && car.change.kind === "price_drop") {
    badges.push(el("span", { class: "badge drop", text: `Price drop ${gbp(car.change.old_price_gbp)} → ${gbp(car.change.new_price_gbp)}` }));
  }
  if (car.near_miss_reason) badges.push(el("span", { class: "badge miss", text: `Near miss: ${car.near_miss_reason}` }));

  const photo = el("div", { class: "car-photo" });
  if (car.image_url && isHttps(car.image_url)) {
    const img = el("img", { src: car.image_url, alt: "", loading: "lazy", referrerpolicy: "no-referrer", decoding: "async" });
    img.addEventListener("error", () => {
      clear(photo);
      photo.append(el("div", { class: "no-photo", text: "Photo couldn't be loaded from the listing site" }));
    });
    photo.append(isHttps(car.url) ? el("a", { href: car.url, target: "_blank", rel: "noopener noreferrer" }, img) : img);
  } else {
    photo.append(el("div", { class: "no-photo", text: "No photo link in the listing" }));
  }

  const value = car.value || {};
  const valueClass = value.diff_gbp == null ? "value" : value.diff_gbp < 0 ? "value below" : value.diff_gbp > 0 ? "value above" : "value";
  const valueBits = [value.note || "Not enough data"];
  if (value.similar != null && value.diff_gbp != null) valueBits.push(`(median of ${value.similar} similar cars in this search).`);
  else valueBits.push("(fewer than 3 similar cars in this search).");
  if (car.site_price_rating) valueBits.push(`${car.source_site} rates it: ${car.site_price_rating}.`);

  const zuto = car.zuto || { result: "Check", reasons: [], note: "Only Zuto gives final approval." };
  const zutoClass = `pill ${String(zuto.result || "check").toLowerCase()}`;

  const fin = estimates(car.price_gbp, (search && search.finance) || {});
  const financeNode = el("div", { class: "finance" },
    el("div", {},
      el("div", { class: "k", text: "HP estimate" }),
      el("div", { class: "v", text: `${gbp(fin.hp.monthly, 2)} a month` }),
      el("div", { class: "s", text: `Total payable ${gbp(fin.hp.total)} over ${fin.months} months` })),
    el("div", {},
      el("div", { class: "k", text: "PCP estimate" }),
      el("div", { class: "v", text: `${gbp(fin.pcp.monthly, 2)} a month` }),
      el("div", { class: "s", text: `Final payment ${gbp(fin.pcp.finalPayment)}, total if kept ${gbp(fin.pcp.totalIfKept)}` })),
    el("div", { class: "finance-note", text: `${ESTIMATE_LABEL} Deposit ${gbp(fin.deposit)}, ${fin.apr}% APR, ${fin.months} months.` }),
  );

  const dealerBits = [];
  const dealer = car.dealer || {};
  if (stated(dealer.name)) dealerBits.push(dealer.name);
  if (stated(dealer.town)) dealerBits.push(dealer.town);
  if (typeof car.distance_miles === "number") dealerBits.push(`${Math.round(car.distance_miles)} miles away`);
  else if (search && search.postcode_district) dealerBits.push("distance not stated");

  const flags = (car.flags || []).map((f) => el("div", { class: "flag", text: `Note: ${f}` }));
  const photoCheck = car.photo_check
    ? el("div", { class: "line", text: `Photo check: ${car.photo_check.label} (${car.photo_check.confidence} confidence)${car.photo_check.note ? ": " + car.photo_check.note : ""}` })
    : null;

  return el("article", { class: "car" },
    photo,
    el("div", { class: "car-body" },
      badges.length ? el("div", { class: "badges" }, badges) : null,
      el("div", {},
        el("div", { class: "car-title", text: title }),
        variant ? el("div", { class: "car-sub", text: variant }) : null),
      el("div", { class: "figures" },
        el("span", { class: "price", text: stated(car.price_text) || gbp(car.price_gbp) }),
        el("span", { class: "figure" }, el("b", { text: stated(car.mileage_text) || `${Number(car.mileage).toLocaleString("en-GB")} miles` })),
        el("span", { class: "figure", text: engine || "Engine not stated" }),
        el("span", { class: "figure", text: [stated(car.gearbox) || "Gearbox not stated", stated(car.body_type) || "Body not stated"].join(", ") }),
      ),
      el("div", { class: "finish" },
        el("span", { class: swatchClass(car.finish) }),
        el("span", {},
          el("b", { text: `${car.finish || "Can't confirm"}` }),
          `. Colour as listed: ${stated(car.colour_listed) || "not stated"}`,
          car.finish_evidence ? el("div", { class: "line" }, "Evidence: ", el("q", { text: car.finish_evidence })) : null,
          car.finish === "Matte wrap" ? el("div", { class: "line", text: "Ask the dealer about the paint under the wrap." }) : null)),
      photoCheck,
      el("div", { class: "line" },
        el("b", { text: dealerBits.join(", ") || "Seller not stated" }),
        `. From ${car.source_site || "source not stated"}, found ${fmtTime(car.fetched_at)}`),
      flags,
      el("div", { class: valueClass, text: valueBits.join(" ") }),
      el("div", { class: "zuto" },
        el("div", { class: "zuto-head" }, el("span", { class: zutoClass, text: zuto.result }), el("span", { text: "Zuto pre-check" })),
        el("details", {}, el("summary", { text: "Why" }),
          el("ul", {}, (zuto.reasons || []).map((r) => el("li", { text: r }))),
          el("div", { class: "help", text: zuto.note || "Only Zuto gives final approval." }))),
      financeNode,
      el("div", { class: "car-actions" },
        safeLink(car.url, "View listing", "view"),
        el("a", { href: ZUTO_QUOTE_URL, target: "_blank", rel: "noopener noreferrer", class: "quote", text: "Get a Zuto quote" })),
      el("div", { class: "help", text: "Zuto says getting a quote has no impact on your credit score." }),
    ),
  );
}

export function siteRow(site) {
  const fetched = !!site.fetched;
  const count = fetched ? `${site.listings_found || 0} listing${site.listings_found === 1 ? "" : "s"}, ${site.pages_fetched || 0} page${site.pages_fetched === 1 ? "" : "s"}` : "not fetched";
  const row = el("div", { class: "site" },
    el("span", { class: "name", text: site.site }),
    site.link && isHttps(site.link.url)
      ? el("a", { href: site.link.url, target: "_blank", rel: "noopener noreferrer", text: site.link.label })
      : el("span", { class: "n", text: count }));
  if (site.error) row.append(el("div", { class: "err", text: `Couldn't read ${site.site}: ${site.error}` }));
  const sub = site.note || site.reason || "";
  if (sub && !fetched) row.append(el("div", { class: "sub", text: sub }));
  else if (sub && fetched && sub !== count) row.append(el("div", { class: "sub", text: sub }));
  if (fetched && site.robots) row.append(el("div", { class: "sub", text: `robots.txt: ${site.robots}` }));
  return row;
}

export function searchSummary(search) {
  if (!search) return "";
  const bits = [search.car];
  if (search.price_max) bits.push(`up to ${gbp(search.price_max)}`);
  if (search.mileage_max) bits.push(`under ${Number(search.mileage_max).toLocaleString("en-GB")} miles`);
  if (search.year_min) bits.push(`${search.year_min}${search.year_max ? `–${search.year_max}` : " or newer"}`);
  bits.push(search.finish === "matte_black" ? "matte black" : search.finish === "matte" ? "matte" : "any finish");
  bits.push(search.sellers === "all" ? "dealers and private" : "dealers only");
  if (search.postcode_district) bits.push(`near ${search.postcode_district}${search.max_distance_miles ? ` within ${search.max_distance_miles} miles` : ""}`);
  return bits.filter(Boolean).join(", ");
}
