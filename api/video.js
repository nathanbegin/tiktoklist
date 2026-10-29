// Fonction Vercel : récupère légende, auteur et hashtags de vidéos TikTok.
// GET /api/video?ids=7341...,7342...   (max 30 IDs par appel)
// Réponse : { results: { "<id>": { statut: "ok"|"indisponible"|"erreur", legende, auteur, pseudo, publie } }, rateLimited }
//
// Source 1 : la page publique de la vidéo (JSON __UNIVERSAL_DATA_FOR_REHYDRATION__).
// Source 2 (plan B) : le lecteur intégré /embed/v2/<id>.
// Note : l'oEmbed de TikTok ne renvoie plus la légende ni l'auteur (vérifié en oct. 2026).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";
const MAX_IDS = 30; // pages d’environ 450 Ko : garder un lot sous ~30 s
const CONCURRENCE = 6; // requêtes simultanées vers TikTok ; plus haut = risque de blocage
const INEXISTANTE = new Set([10204, 10216, 10217, 10222, 10101]); // supprimée, privée, restreinte…

class RateLimited extends Error {}

async function lire(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.8" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (r.status === 429) throw new RateLimited();
    return { status: r.status, html: await r.text() };
  } finally {
    clearTimeout(t);
  }
}

function scriptJson(html, id) {
  const i = html.indexOf(`id="${id}"`);
  if (i < 0) return null;
  const debut = html.indexOf(">", i) + 1;
  try { return JSON.parse(html.slice(debut, html.indexOf("</script>", debut))); } catch { return null; }
}

// Source 1 : page de la vidéo
async function depuisPage(id) {
  const { html } = await lire(`https://www.tiktok.com/@/video/${id}`);
  const d = scriptJson(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const vd = d?.__DEFAULT_SCOPE__?.["webapp.video-detail"];
  if (!vd) return null; // page sans données (vérification anti-robot, etc.)
  const it = vd.itemInfo?.itemStruct;
  if (vd.statusCode === 0 && it) {
    return {
      statut: "ok",
      legende: it.desc || "",
      auteur: it.author?.nickname || "",
      pseudo: it.author?.uniqueId || "",
      publie: it.createTime ? new Date(Number(it.createTime) * 1000).toISOString().slice(0, 10) : "",
    };
  }
  if (INEXISTANTE.has(vd.statusCode) || (vd.statusCode && !it)) return { statut: "indisponible" };
  return null;
}

// Source 2 : lecteur intégré
async function depuisEmbed(id) {
  const { status, html } = await lire(`https://www.tiktok.com/embed/v2/${id}`);
  const m = html.match(/"itemInfos":\{"id":"(\d+)","text":"((?:[^"\\]|\\.)*)"/);
  if (!m) return status === 503 || status === 404 ? { statut: "indisponible" } : null;
  const a = html.match(/"authorInfos":\{[^{}]*?"uniqueId":"([^"]+)","nickName":"((?:[^"\\]|\\.)*)"/);
  const dec = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
  return { statut: "ok", legende: dec(m[2]), auteur: a ? dec(a[2]) : "", pseudo: a ? a[1] : "", publie: "" };
}

async function enrichir(id) {
  let r = null;
  try { r = await depuisPage(id); } catch (e) { if (e instanceof RateLimited) throw e; }
  if (r?.statut === "ok") return r;
  let e2 = null;
  try { e2 = await depuisEmbed(id); } catch (e) { if (e instanceof RateLimited) throw e; }
  if (e2?.statut === "ok") return e2;
  // Les deux sources disent « absente » (ou la page le dit clairement) → indisponible ; sinon on réessaiera.
  if (r?.statut === "indisponible" || e2?.statut === "indisponible") return { statut: "indisponible" };
  return { statut: "erreur" };
}

module.exports = async (req, res) => {
  const ids = String(req.query.ids || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{5,25}$/.test(s))
    .slice(0, MAX_IDS);

  if (!ids.length) {
    res.status(400).json({ erreur: "Paramètre ids manquant (IDs numériques séparés par des virgules)." });
    return;
  }

  const results = {};
  let rateLimited = false;
  const file = [...ids];

  async function travailleur() {
    while (file.length && !rateLimited) {
      const id = file.shift();
      try {
        results[id] = await enrichir(id);
      } catch (e) {
        if (e instanceof RateLimited) rateLimited = true;
        else results[id] = { statut: "erreur" };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCE }, travailleur));

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ results, rateLimited });
};
