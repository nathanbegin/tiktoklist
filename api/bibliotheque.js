// Bibliothèque partagée entre appareils.
// GET    /api/bibliotheque?maj=<curseur>&id=<curseur>  → vidéos modifiées après le curseur (par pages de 2000)
// POST   /api/bibliotheque  { videos: [...] }           → ajoute ou met à jour (fusion des sources ; une légende « ok » n’est jamais écrasée)
// DELETE /api/bibliotheque                              → vide tout (les autres appareils se vident à leur prochaine synchro)
import { sql, schema, garde, corps } from "../lib/commun.js";

const PAGE = 2000;
const MAX_POST = 3000;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!garde(req, res)) return;
  try {
    await schema();

    if (req.method === "GET") {
      const maj = String(req.query.maj || "1970-01-01T00:00:00Z");
      const id = String(req.query.id || "");
      const lignes = await sql`
        SELECT id, data, maj::text AS maj FROM videos
        WHERE (maj, id) > (${maj}::timestamptz, ${id})
        ORDER BY maj, id LIMIT ${PAGE}`;
      const [reinit] = await sql`SELECT valeur FROM config WHERE cle = 'reinit'`;
      const der = lignes[lignes.length - 1];
      res.status(200).json({
        videos: lignes.map((l) => l.data),
        curseur: der ? { maj: der.maj, id: der.id } : { maj, id },
        suite: lignes.length === PAGE,
        reinit: reinit?.valeur ?? null,
      });
      return;
    }

    if (req.method === "POST") {
      const videos = (corps(req).videos || [])
        .filter((v) => v && /^\d{5,25}$/.test(String(v.id)))
        .slice(0, MAX_POST);
      // une seule entrée par id (sinon Postgres refuse l'upsert)
      const uniques = [...new Map(videos.map((v) => [String(v.id), v])).values()];
      if (!uniques.length) { res.status(200).json({ n: 0 }); return; }
      await sql`
        INSERT INTO videos (id, data, maj)
        SELECT e->>'id', e, now() FROM jsonb_array_elements(${JSON.stringify(uniques)}::jsonb) AS e
        ON CONFLICT (id) DO UPDATE SET
          data = (CASE
                    WHEN videos.data->>'statut' = 'ok' AND excluded.data->>'statut' IS DISTINCT FROM 'ok'
                    THEN videos.data
                    ELSE videos.data || excluded.data
                  END)
                 || jsonb_build_object('sources',
                      COALESCE(videos.data->'sources', '{}'::jsonb) || COALESCE(excluded.data->'sources', '{}'::jsonb)),
          maj = now()`;
      res.status(200).json({ n: uniques.length });
      return;
    }

    if (req.method === "DELETE") {
      await sql`DELETE FROM videos`;
      const maintenant = new Date().toISOString();
      await sql`
        INSERT INTO config (cle, valeur) VALUES ('reinit', ${JSON.stringify(maintenant)}::jsonb)
        ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur, maj = now()`;
      res.status(200).json({ reinit: maintenant });
      return;
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    res.status(405).json({ erreur: "Méthode non permise." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erreur: "Erreur de base de données : " + e.message });
  }
}
