// Fonction Vercel : récupère légende, auteur et hashtags de vidéos TikTok via l'oEmbed public.
// GET /api/oembed?ids=7341...,7342...   (max 50 IDs par appel)
// Réponse : { results: { "<id>": { statut: "ok"|"indisponible"|"erreur", legende, auteur, pseudo } }, rateLimited }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";
const MAX_IDS = 50;
const CONCURRENCE = 6; // requêtes simultanées vers TikTok ; plus haut = risque de 429

class RateLimited extends Error {}

async function oembed(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch("https://www.tiktok.com/oembed?url=" + encodeURIComponent(url), {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (r.status === 429) throw new RateLimited();
    if (!r.ok) return null; // 400/404 : vidéo absente ou lien non reconnu
    const d = await r.json().catch(() => null);
    return d && (d.title !== undefined || d.author_name) ? d : null;
  } finally {
    clearTimeout(t);
  }
}

async function enrichir(id) {
  let erreurReseau = false;
  for (const url of [`https://www.tiktok.com/@/video/${id}`, `https://www.tiktokv.com/share/video/${id}/`]) {
    try {
      const d = await oembed(url);
      if (d) {
        return {
          statut: "ok",
          legende: d.title || "",
          auteur: d.author_name || "",
          pseudo: d.author_unique_id || (d.author_url || "").split("@")[1] || "",
        };
      }
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      erreurReseau = true;
    }
  }
  // "erreur" = à réessayer plus tard ; "indisponible" = supprimée ou privée
  return { statut: erreurReseau ? "erreur" : "indisponible" };
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
