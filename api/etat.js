// GET /api/etat : indique si la base est branchée et si la clé envoyée est valide.
import { bdActive, cleRequise, cleValide } from "../lib/commun.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ bd: bdActive, cleRequise, cleValide: cleValide(req) });
}
