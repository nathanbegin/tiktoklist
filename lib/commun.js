// Outils partagés : connexion Neon, création des tables, clé d'accès.
import { neon } from "@neondatabase/serverless";
import { timingSafeEqual } from "node:crypto";

// La base Neon branchée par Vercel (ex. « neon-tiktoklist ») expose DATABASE_URL, parfois avec un préfixe
// (NEON_TIKTOKLIST_DATABASE_URL…). On prend la première trouvée.
function trouverUrlBd() {
  const env = process.env;
  const direct = env.DATABASE_URL || env.POSTGRES_URL;
  if (direct) return direct;
  const cle = Object.keys(env).sort().find((k) => /(^|_)(DATABASE_URL|POSTGRES_URL)$/.test(k) && /^postgres(ql)?:\/\//.test(env[k] || ""));
  return cle ? env[cle] : "";
}
const URL_BD = trouverUrlBd();
export const bdActive = Boolean(URL_BD);
export const sql = bdActive ? neon(URL_BD) : null;

let schemaPret = null;
export function schema() {
  if (!schemaPret) {
    schemaPret = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS videos (
        id   text PRIMARY KEY,
        data jsonb NOT NULL,
        maj  timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS videos_maj_id ON videos (maj, id)`;
      await sql`CREATE TABLE IF NOT EXISTS config (
        cle    text PRIMARY KEY,
        valeur jsonb NOT NULL,
        maj    timestamptz NOT NULL DEFAULT now()
      )`;
    })().catch((e) => { schemaPret = null; throw e; });
  }
  return schemaPret;
}

// Clé d'accès : variable d'environnement ACCES_CLE. Si elle est définie, chaque appel doit l'envoyer (en-tête x-cle).
const CLE = process.env.ACCES_CLE || "";
export const cleRequise = Boolean(CLE);
export function cleValide(req) {
  if (!CLE) return true;
  const recue = Buffer.from(String(req.headers["x-cle"] || ""));
  const attendue = Buffer.from(CLE);
  return recue.length === attendue.length && timingSafeEqual(recue, attendue);
}

export function garde(req, res, { bd = true } = {}) {
  if (!cleValide(req)) {
    res.status(401).json({ erreur: "Clé d’accès manquante ou invalide. Entre-la dans Réglages." });
    return false;
  }
  if (bd && !bdActive) {
    res.status(503).json({ erreur: "Aucune base de données configurée (variable DATABASE_URL absente)." });
    return false;
  }
  return true;
}

export function corps(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}
