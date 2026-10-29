// GET /api/reglages → réglages enregistrés ; PUT /api/reglages { reglages: {...} } → enregistre.
import { sql, schema, garde, corps } from "../lib/commun.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!garde(req, res)) return;
  try {
    await schema();
    if (req.method === "GET") {
      const [l] = await sql`SELECT valeur FROM config WHERE cle = 'reglages'`;
      res.status(200).json({ reglages: l?.valeur ?? null });
      return;
    }
    if (req.method === "PUT") {
      const r = corps(req).reglages;
      if (!r || typeof r !== "object" || Array.isArray(r)) { res.status(400).json({ erreur: "Réglages invalides." }); return; }
      await sql`
        INSERT INTO config (cle, valeur) VALUES ('reglages', ${JSON.stringify(r)}::jsonb)
        ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur, maj = now()`;
      res.status(200).json({ ok: true });
      return;
    }
    res.setHeader("Allow", "GET, PUT");
    res.status(405).json({ erreur: "Méthode non permise." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erreur: "Erreur de base de données : " + e.message });
  }
}
